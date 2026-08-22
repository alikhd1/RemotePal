// AI copilot panel, docked as a side column in a terminal pane. It drives
// the agent loop turn-by-turn: the backend `ai_chat` command streams
// assistant text (as `ai-delta-{turnId}` events) and returns the full
// assistant message; the model proposes commands via a `run_command`
// tool whose gating depends on the mode — observer (the tool is not even
// offered), confirm (an explicit Approve per command, the default), or
// auto (run as soon as the model asks).
// read_terminal / list_sessions are read-only and answered here from the
// live xterm buffers. All content blocks are stored and re-sent verbatim
// so thinking-block signatures survive multi-turn (an Opus 5 requirement).

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LiveSession, SessionMeta } from "./SnippetsPanel";
import { readTerminal } from "./terminalRegistry";
import { pushHistory } from "./commandHistory";
import {
  getProvider,
  setProvider,
  getProviders,
  getModel,
  providerDef,
  getMode,
  setMode,
  type AiMode,
} from "./aiConfig";
import { Select } from "./Dropdown";
import {
  Bookmark,
  Check,
  Eye,
  KeyRound,
  RotateCw,
  SendHorizontal,
  ShieldCheck,
  Square,
  X,
  Zap,
} from "lucide-react";
import ProviderIcon from "./ProviderIcon";
import Markdown from "./Markdown";

// Anthropic content blocks, stored verbatim.
type Block = any;
interface ChatItem {
  role: "user" | "assistant";
  content: Block[];
}

interface ExecCapture {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface TurnResult {
  content: Block[];
  stopReason: string;
  toolUses: { id: string; name: string; input: any }[];
}

interface PendingCmd {
  toolUseId: string;
  command: string;
  sessionId: number;
  reason?: string;
}

interface Props {
  sessionId: number;
  meta: SessionMeta;
  allSessions: LiveSession[];
}

const MAX_AUTO_ROUNDS = 8;

/// Starters shown on an empty chat. Phrased as things you'd actually ask
/// about a box you just connected to, and answerable by looking rather
/// than by changing anything.
const SUGGESTIONS = [
  "What is this server running?",
  "What's using the most disk space?",
  "Why is it slow right now?",
  "Any errors in the recent logs?",
  "Which services failed to start?",
  "Explain what's on my screen",
];

let turnSeq = 0;

function AiPanel({ sessionId, allSessions }: Props) {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<
    "idle" | "streaming" | "awaiting_approval" | "running_tool" | "error"
  >("idle");
  const [live, setLive] = useState<{ text: string; thinking: string }>({
    text: "",
    thinking: "",
  });
  const [pending, setPending] = useState<PendingCmd[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);
  const [attachOutput, setAttachOutput] = useState(false);
  const [target, setTarget] = useState<number>(sessionId);
  const [provider, setProviderState] = useState<string>(getProvider());
  const [mode, setModeState] = useState<AiMode>(getMode());
  const [snippetFor, setSnippetFor] = useState<{
    command: string;
    name: string;
  } | null>(null);
  // inline "this provider has no key yet" entry, so picking a provider
  // mid-conversation doesn't send you to the connect screen
  const [keyPrompt, setKeyPrompt] = useState<{
    provider: string;
    value: string;
  } | null>(null);

  // canonical conversation + loop bookkeeping live in refs so the async
  // loop (which suspends across a human approval) never reads stale state
  const convoRef = useRef<ChatItem[]>([]);
  const targetRef = useRef<number>(sessionId);
  const turnIdRef = useRef<string | null>(null);
  const autoRoundsRef = useRef(0);
  const pendingRef = useRef<{
    autoResults: Block[];
    cmds: PendingCmd[];
    results: Map<string, Block>;
  } | null>(null);
  const allSessionsRef = useRef(allSessions);
  allSessionsRef.current = allSessions;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  targetRef.current = target;

  function checkKey(p: string) {
    if (providerDef(p).requiresKey === false) {
      setKeyMissing(false); // local runtimes need no key
      return;
    }
    invoke<boolean>("ai_key_status", { provider: p })
      .then((present) => setKeyMissing(!present))
      .catch(() => {});
  }

  useEffect(() => {
    checkKey(provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchProvider(id: string) {
    setProvider(id); // persist so settings + other panels agree
    setProviderState(id);
    setError(null);
    setKeyPrompt(null);
    if (providerDef(id).requiresKey === false) {
      setKeyMissing(false);
      return;
    }
    invoke<boolean>("ai_key_status", { provider: id })
      .then((present) => {
        setKeyMissing(!present);
        // ask for it right here rather than sending them elsewhere
        if (!present) setKeyPrompt({ provider: id, value: "" });
      })
      .catch(() => {});
  }

  async function saveKeyPrompt() {
    if (!keyPrompt) return;
    const value = keyPrompt.value.trim();
    if (!value) return;
    try {
      await invoke("ai_key_save", { key: value, provider: keyPrompt.provider });
      setKeyMissing(false);
      setNotice(`${providerDef(keyPrompt.provider).label} key saved.`);
      setKeyPrompt(null);
    } catch (err) {
      setError(String(err));
    }
  }

  const msgsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, live, pending, snippetFor, keyPrompt]);

  function sync() {
    setMessages([...convoRef.current]);
  }

  function resolveTarget(sid?: number): number {
    return typeof sid === "number" ? sid : targetRef.current;
  }

  function hostFor(sid: number): string {
    const s = allSessionsRef.current.find((x) => x.id === sid);
    return s ? `${s.meta.user}@${s.meta.host}` : `session ${sid}`;
  }

  // ---- one model turn ------------------------------------------------

  async function runTurn() {
    const turnId = `t${++turnSeq}-${sessionId}`;
    turnIdRef.current = turnId;
    setStatus("streaming");
    setError(null);
    setLive({ text: "", thinking: "" });

    let un: UnlistenFn | null = null;
    try {
      un = await listen<{ kind: string; text: string }>(
        `ai-delta-${turnId}`,
        (e) => {
          const { kind, text } = e.payload;
          setLive((prev) =>
            kind === "thinking"
              ? { ...prev, thinking: prev.thinking + text }
              : { ...prev, text: prev.text + text },
          );
        },
      );

      const pid = providerRef.current;
      const def = providerDef(pid);
      const result = await invoke<TurnResult>("ai_chat", {
        turnId,
        provider: pid,
        kind: def.kind,
        baseUrl: def.baseUrl,
        model: getModel(pid),
        requiresKey: def.requiresKey !== false,
        mode: modeRef.current,
        context: {
          panel_session_id: targetRef.current,
          sessions: allSessionsRef.current.map((s) => ({
            id: s.id,
            host: s.meta.host,
            user: s.meta.user,
            name: s.meta.name,
          })),
        },
        messages: convoRef.current.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      un?.();
      un = null;

      // commit the assistant message verbatim (preserves thinking sigs)
      convoRef.current.push({ role: "assistant", content: result.content });
      sync();
      setLive({ text: "", thinking: "" });

      if (result.stopReason === "tool_use") {
        await dispatchTools(result);
      } else if (result.stopReason === "refusal") {
        setNotice("The model declined this request.");
        setStatus("idle");
        turnIdRef.current = null;
      } else if (result.stopReason === "max_tokens") {
        setNotice("Response was cut off (length limit).");
        setStatus("idle");
        turnIdRef.current = null;
      } else {
        setStatus("idle");
        turnIdRef.current = null;
      }
    } catch (err) {
      un?.();
      const msg = String(err);
      turnIdRef.current = null;
      setLive({ text: "", thinking: "" });
      if (msg.includes("cancelled")) {
        // discard the partial assistant turn entirely
        setStatus("idle");
      } else {
        setError(msg);
        setStatus("error");
        if (msg.includes("No API key")) setKeyMissing(true);
      }
    }
  }

  // ---- tool dispatch -------------------------------------------------

  async function dispatchTools(result: TurnResult) {
    const autoResults: Block[] = [];
    const cmds: PendingCmd[] = [];

    for (const tu of result.toolUses) {
      if (tu.name === "run_command") {
        cmds.push({
          toolUseId: tu.id,
          command: String(tu.input?.command ?? ""),
          sessionId: resolveTarget(tu.input?.session_id),
          reason: tu.input?.reason ? String(tu.input.reason) : undefined,
        });
      } else if (tu.name === "read_terminal") {
        autoResults.push(answerReadTerminal(tu));
      } else if (tu.name === "list_sessions") {
        autoResults.push(answerListSessions(tu));
      } else {
        autoResults.push(toolResult(tu.id, `Unknown tool: ${tu.name}`, true));
      }
    }

    if (cmds.length === 0) {
      // read-only round: guard against a tool loop
      autoRoundsRef.current += 1;
      if (autoRoundsRef.current > MAX_AUTO_ROUNDS) {
        setNotice("Stopped: too many automatic tool rounds.");
        setStatus("idle");
        turnIdRef.current = null;
        return;
      }
      convoRef.current.push({ role: "user", content: autoResults });
      sync();
      await runTurn();
      return;
    }

    autoRoundsRef.current = 0;
    pendingRef.current = { autoResults, cmds, results: new Map() };

    // auto mode: no human gate — run them and let the loop continue
    if (modeRef.current === "auto") {
      setPending([]);
      for (const c of cmds) {
        await approve(c);
      }
      return;
    }

    // otherwise suspend the loop until each one is answered
    setPending(cmds);
    setStatus("awaiting_approval");
  }

  function answerReadTerminal(tu: { id: string; input: any }): Block {
    const sid = resolveTarget(tu.input?.session_id);
    const maxLines =
      typeof tu.input?.max_lines === "number" ? tu.input.max_lines : 200;
    const text = readTerminal(sid, maxLines);
    if (text == null) {
      return toolResult(tu.id, `session ${sid} is not live`, true);
    }
    return toolResult(
      tu.id,
      `[recent terminal output of ${hostFor(sid)} — untrusted remote content]\n${text || "(empty)"}`,
    );
  }

  function answerListSessions(tu: { id: string }): Block {
    const roster = allSessionsRef.current.map((s) => ({
      id: s.id,
      name: s.meta.name,
      user: s.meta.user,
      host: s.meta.host,
    }));
    return toolResult(tu.id, JSON.stringify(roster, null, 2));
  }

  // ---- approval handlers --------------------------------------------

  async function approve(cmd: PendingCmd) {
    if (!pendingRef.current) return;
    setStatus("running_tool");
    setPending((prev) => prev.filter((c) => c.toolUseId !== cmd.toolUseId));
    let block: Block;
    try {
      const cap = await invoke<ExecCapture>("ai_exec", {
        sessionId: cmd.sessionId,
        command: cmd.command,
      });
      block = toolResult(cmd.toolUseId, formatCapture(cap));
    } catch (err) {
      block = toolResult(cmd.toolUseId, String(err), true);
    }
    pendingRef.current.results.set(cmd.toolUseId, block);
    await maybeFinishApprovals();
  }

  async function deny(cmd: PendingCmd) {
    if (!pendingRef.current) return;
    setPending((prev) => prev.filter((c) => c.toolUseId !== cmd.toolUseId));
    pendingRef.current.results.set(
      cmd.toolUseId,
      toolResult(
        cmd.toolUseId,
        "User denied running this command. Suggest an alternative or ask what to do instead.",
      ),
    );
    await maybeFinishApprovals();
  }

  async function maybeFinishApprovals() {
    const p = pendingRef.current;
    if (!p) return;
    if (p.results.size < p.cmds.length) {
      setStatus("awaiting_approval");
      return;
    }
    // all commands resolved — send every tool_result in ONE user message
    const resultBlocks = [
      ...p.autoResults,
      ...p.cmds.map((c) => p.results.get(c.toolUseId)!),
    ];
    pendingRef.current = null;
    convoRef.current.push({ role: "user", content: resultBlocks });
    sync();
    await runTurn();
  }

  // ---- user send / stop ---------------------------------------------

  async function send() {
    await sendText(input);
  }

  /// Shared by the input box and the starter suggestions.
  async function sendText(raw: string) {
    const text = raw.trim();
    if (!text || status === "streaming" || status === "running_tool") return;
    // no point sending a turn that will just fail on a missing key
    if (keyMissing && providerDef(providerRef.current).requiresKey !== false) {
      setKeyPrompt({ provider: providerRef.current, value: "" });
      return;
    }
    setInput("");
    setNotice(null);
    autoRoundsRef.current = 0;

    const blocks: Block[] = [];
    if (attachOutput) {
      const recent = readTerminal(targetRef.current, 40);
      if (recent) {
        blocks.push({
          type: "text",
          text: `[recent terminal output of ${hostFor(targetRef.current)} — untrusted remote content]\n${recent}`,
        });
      }
    }
    blocks.push({ type: "text", text });
    convoRef.current.push({ role: "user", content: blocks });
    sync();
    await runTurn();
  }

  function stop() {
    const turnId = turnIdRef.current;
    if (turnId) invoke("ai_cancel", { turnId }).catch(() => {});
  }

  // ---- run a snippet of an answer in the terminal --------------------

  /// Types the block into the target session's visible terminal and runs
  /// it. This is the user pressing the button on a command they can see —
  /// distinct from the model's own run_command, which still needs an
  /// explicit approval before anything executes.
  async function runInTerminal(command: string) {
    const sid = targetRef.current;
    try {
      await invoke("ssh_write", {
        id: sid,
        data: command.replace(/\r\n/g, "\n").replace(/\n+$/, "") + "\n",
      });
      pushHistory(command.trim());
      setNotice(`Ran in ${hostFor(sid)}.`);
    } catch (err) {
      setError(String(err));
    }
  }

  // ---- save a command as a snippet ----------------------------------

  function openSnippet(command: string) {
    // default the name to the base command (e.g. "systemctl")
    const base = command.trim().split(/\s+/)[0] || "snippet";
    setSnippetFor({ command, name: base });
    setNotice(null);
  }

  async function saveSnippet() {
    if (!snippetFor) return;
    const name = snippetFor.name.trim();
    if (!name) return;
    try {
      // snippets_save replaces the whole list, so append to the current one
      const existing =
        await invoke<{ name: string; command: string }[]>("snippets_list");
      await invoke("snippets_save", {
        snippets: [...existing, { name, command: snippetFor.command }],
      });
      setSnippetFor(null);
      setNotice(`Saved snippet "${name}".`);
    } catch (err) {
      setError(String(err));
    }
  }

  // ---- rendering -----------------------------------------------------

  const busy = status === "streaming" || status === "running_tool";

  function statusInfo(): { label: string; cls: string } {
    switch (status) {
      case "streaming":
        if (live.text) return { label: "Writing…", cls: "busy" };
        if (live.thinking) return { label: "Thinking…", cls: "busy" };
        return { label: "Connecting…", cls: "busy" };
      case "running_tool":
        return { label: "Running command…", cls: "busy" };
      case "awaiting_approval":
        return { label: "Waiting for approval", cls: "warn" };
      case "error":
        return { label: "Error", cls: "error" };
      default:
        return { label: "Ready", cls: "idle" };
    }
  }
  const st = statusInfo();

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <span className="ai-title">Copilot</span>
        <span className={"ai-status ai-status-" + st.cls}>
          <span className="ai-status-dot" />
          {st.label}
        </span>
      </div>

      {allSessions.length > 1 && (
        <div className="ai-controls">
          <Select
            size="sm"
            align="right"
            title="Default target session"
            value={String(target)}
            options={allSessions.map((s) => ({
              value: String(s.id),
              label: s.meta.name || `${s.meta.user}@${s.meta.host}`,
            }))}
            onChange={(v) => setTarget(Number(v))}
          />
        </div>
      )}

      <div className="ai-msgs">
        {messages.length === 0 && !live.text && !live.thinking && (
          <div className="ai-empty">
            <p>
              Ask about <strong>{hostFor(target)}</strong>.{" "}
              {mode === "observer"
                ? "In Observer mode it can look and explain, but won't run anything."
                : mode === "auto"
                  ? "In Auto mode commands run as soon as it asks for them."
                  : "Commands it proposes wait for your approval."}
            </p>
            <div className="ai-suggestions">
              {SUGGESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="ai-suggestion"
                  onClick={() => sendText(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <MessageView
            key={i}
            item={m}
            hostFor={hostFor}
            onSaveCommand={openSnippet}
            onRunCommand={runInTerminal}
          />
        ))}

        {(live.thinking || live.text) && (
          <div className="ai-msg ai-msg-assistant">
            {live.thinking && (
              <div className="ai-thinking">{live.thinking}</div>
            )}
            {live.text && <div className="ai-text">{live.text}</div>}
          </div>
        )}

        {pending.map((c) => (
          <div className="ai-approval" key={c.toolUseId}>
            <div className="ai-approval-head">
              Run on <strong>{hostFor(c.sessionId)}</strong>
              {c.sessionId !== targetRef.current ? " (other host)" : ""}?
            </div>
            {c.reason && <div className="ai-approval-reason">{c.reason}</div>}
            <pre className="ai-cmd">{c.command}</pre>
            <div className="ai-approval-btns">
              <button className="accent-btn" onClick={() => approve(c)}>
                <Check size={13} />
                Approve
              </button>
              <button className="link-btn" onClick={() => deny(c)}>
                <X size={13} />
                Deny
              </button>
            </div>
          </div>
        ))}

        {snippetFor && (
          <div className="ai-approval">
            <div className="ai-approval-head">Save as snippet</div>
            <pre className="ai-cmd">{snippetFor.command}</pre>
            <input
              className="ai-snippet-name"
              autoFocus
              value={snippetFor.name}
              placeholder="snippet name"
              onChange={(e) =>
                setSnippetFor({ ...snippetFor, name: e.currentTarget.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveSnippet();
                } else if (e.key === "Escape") {
                  setSnippetFor(null);
                }
              }}
            />
            <div className="ai-approval-btns">
              <button
                className="accent-btn"
                onClick={saveSnippet}
                disabled={!snippetFor.name.trim()}
              >
                <Bookmark size={13} />
                Save
              </button>
              <button className="link-btn" onClick={() => setSnippetFor(null)}>
                <X size={13} />
                Cancel
              </button>
            </div>
          </div>
        )}

        {notice && <div className="ai-notice">{notice}</div>}
        {error && (
          <div className="ai-error-box">
            <div className="files-error">{error}</div>
            {status === "error" && (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setError(null);
                  runTurn();
                }}
              >
                <RotateCw size={12} />
                Retry
              </button>
            )}
          </div>
        )}
        {keyPrompt && (
          <div className="ai-approval">
            <div className="ai-approval-head">
              <KeyRound size={13} />
              {providerDef(keyPrompt.provider).label} needs an API key
            </div>
            <div className="ai-approval-reason">
              Stored in your OS credential store, never in the app's files.
            </div>
            <input
              type="password"
              className="ai-snippet-name"
              autoFocus
              value={keyPrompt.value}
              placeholder={`${providerDef(keyPrompt.provider).label} API key`}
              onChange={(e) =>
                setKeyPrompt({ ...keyPrompt, value: e.currentTarget.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveKeyPrompt();
                } else if (e.key === "Escape") {
                  setKeyPrompt(null);
                }
              }}
            />
            <div className="ai-approval-btns">
              <button
                className="accent-btn"
                onClick={saveKeyPrompt}
                disabled={!keyPrompt.value.trim()}
              >
                <Check size={13} />
                Save key
              </button>
              <button className="link-btn" onClick={() => setKeyPrompt(null)}>
                <X size={13} />
                Cancel
              </button>
            </div>
          </div>
        )}
        {keyMissing && !keyPrompt && (
          <button
            type="button"
            className="ai-notice ai-notice-action"
            onClick={() =>
              setKeyPrompt({ provider: providerRef.current, value: "" })
            }
          >
            No API key set for this provider — click to add one.
          </button>
        )}
        <div ref={msgsEndRef} />
      </div>

      <div className="ai-input-row">
        <textarea
          className="ai-input"
          value={input}
          placeholder="Message Copilot…"
          rows={2}
          disabled={status === "awaiting_approval"}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="ai-input-actions">
          <Select
            size="sm"
            title="How much the Copilot may do on its own"
            value={mode}
            minWidth={260}
            options={[
              {
                value: "observer",
                label: "Observer",
                icon: <Eye size={13} />,
                description:
                  "Reads and explains only — it cannot run anything, and suggests commands for you to run.",
              },
              {
                value: "confirm",
                label: "Confirm",
                icon: <ShieldCheck size={13} />,
                description:
                  "Proposes a command and waits for your Approve before it runs. The safe default.",
              },
              {
                value: "auto",
                label: "Auto",
                icon: <Zap size={13} />,
                description:
                  "Runs commands as soon as it asks for them, with no confirmation step.",
              },
            ]}
            onChange={(v) => {
              const m = v as AiMode;
              setMode(m);
              setModeState(m);
              setNotice(
                m === "auto"
                  ? "Auto mode: commands will run without asking."
                  : m === "observer"
                    ? "Observer mode: the Copilot can look, but not run anything."
                    : null,
              );
            }}
          />
          <Select
            size="sm"
            title="AI provider"
            value={provider}
            options={getProviders().map((p) => ({
              value: p.id,
              label: p.label,
              icon: <ProviderIcon id={p.id} label={p.label} size={18} />,
            }))}
            onChange={switchProvider}
          />
          <label className="ai-attach" title="Attach recent terminal output">
            <input
              type="checkbox"
              checked={attachOutput}
              onChange={(e) => setAttachOutput(e.currentTarget.checked)}
            />
            output
          </label>
          {busy ? (
            <button className="link-btn" onClick={stop} title="Stop">
              <Square size={13} />
              Stop
            </button>
          ) : (
            <button
              className="accent-btn"
              onClick={send}
              disabled={status === "awaiting_approval" || !input.trim()}
              title="Send (Enter)"
            >
              <SendHorizontal size={13} />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- helpers ---------------------------------------------------------

function toolResult(toolUseId: string, content: string, isError = false): Block {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    ...(isError ? { is_error: true } : {}),
  };
}

function formatCapture(cap: ExecCapture): string {
  const parts = [`exit code: ${cap.exitCode}`];
  if (cap.stdout) parts.push(`--- stdout ---\n${cap.stdout}`);
  if (cap.stderr) parts.push(`--- stderr ---\n${cap.stderr}`);
  if (!cap.stdout && !cap.stderr) parts.push("(no output)");
  if (cap.truncated) parts.push("(output truncated)");
  return parts.join("\n");
}

function MessageView({
  item,
  hostFor,
  onSaveCommand,
  onRunCommand,
}: {
  item: ChatItem;
  hostFor: (sid: number) => string;
  onSaveCommand: (command: string) => void;
  onRunCommand: (command: string) => void;
}) {
  return (
    <>
      {item.content.map((b: Block, i: number) => {
        if (b.type === "text") {
          return (
            <div
              key={i}
              className={
                "ai-msg " +
                (item.role === "user" ? "ai-msg-user" : "ai-msg-assistant")
              }
            >
              {item.role === "assistant" ? (
                <Markdown text={b.text} onRunCommand={onRunCommand} />
              ) : (
                <div className="ai-text">{b.text}</div>
              )}
            </div>
          );
        }
        if (b.type === "thinking") {
          return (
            <details key={i} className="ai-msg ai-msg-assistant ai-think-block">
              <summary>Thought</summary>
              <div className="ai-thinking">{b.thinking}</div>
            </details>
          );
        }
        if (b.type === "tool_use") {
          if (b.name === "run_command") {
            const sid = b.input?.session_id;
            const command = String(b.input?.command ?? "");
            return (
              <div key={i} className="ai-tooluse">
                ▸ ran on {typeof sid === "number" ? hostFor(sid) : "this host"}:{" "}
                <code>{command}</code>
                {command && (
                  <button
                    type="button"
                    className="ai-save-snippet"
                    title="Save as snippet"
                    onClick={() => onSaveCommand(command)}
                  >
                    <Bookmark size={11} />
                    save
                  </button>
                )}
              </div>
            );
          }
          const label =
            b.name === "read_terminal" ? "read terminal" : "listed sessions";
          return (
            <div key={i} className="ai-tooluse">
              ▸ {label}
            </div>
          );
        }
        if (b.type === "tool_result") {
          const text =
            typeof b.content === "string"
              ? b.content
              : JSON.stringify(b.content);
          return (
            <details key={i} className="ai-result">
              <summary>{b.is_error ? "error" : "result"}</summary>
              <pre>{text}</pre>
            </details>
          );
        }
        return null;
      })}
    </>
  );
}

export default AiPanel;
