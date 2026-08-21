// AI copilot panel, docked as a side column in a terminal pane. It drives
// the agent loop turn-by-turn: the backend `ai_chat` command streams
// assistant text (as `ai-delta-{turnId}` events) and returns the full
// assistant message; the model proposes commands via a `run_command`
// tool that ALWAYS requires the user to approve before `ai_exec` runs it.
// read_terminal / list_sessions are read-only and answered here from the
// live xterm buffers. All content blocks are stored and re-sent verbatim
// so thinking-block signatures survive multi-turn (an Opus 5 requirement).

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LiveSession, SessionMeta } from "./SnippetsPanel";
import { readTerminal } from "./terminalRegistry";
import { getProvider, getModel } from "./aiConfig";
import { Select } from "./Dropdown";

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

  targetRef.current = target;

  useEffect(() => {
    invoke<boolean>("ai_key_status", { provider: getProvider() })
      .then((present) => setKeyMissing(!present))
      .catch(() => {});
  }, []);

  const msgsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, live, pending]);

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

      const provider = getProvider();
      const result = await invoke<TurnResult>("ai_chat", {
        turnId,
        provider,
        model: getModel(provider),
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

    // at least one command needs approval — suspend the loop
    autoRoundsRef.current = 0;
    pendingRef.current = { autoResults, cmds, results: new Map() };
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
    const text = input.trim();
    if (!text || status === "streaming" || status === "running_tool") return;
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

  // ---- rendering -----------------------------------------------------

  const busy = status === "streaming" || status === "running_tool";

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <span className="ai-title">Copilot</span>
        {allSessions.length > 1 && (
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
        )}
      </div>

      <div className="ai-msgs">
        {messages.length === 0 && !live.text && !live.thinking && (
          <div className="ai-empty">
            Ask about this server, or have Copilot propose commands to run.
            Every command needs your approval first.
          </div>
        )}

        {messages.map((m, i) => (
          <MessageView key={i} item={m} hostFor={hostFor} />
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
                Approve
              </button>
              <button className="link-btn" onClick={() => deny(c)}>
                Deny
              </button>
            </div>
          </div>
        ))}

        {notice && <div className="ai-notice">{notice}</div>}
        {error && <div className="files-error">{error}</div>}
        {keyMissing && (
          <div className="ai-notice">
            No API key set. Add one in the AI card on the connect screen.
          </div>
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
          {busy ? (
            <button className="link-btn" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              className="accent-btn"
              onClick={send}
              disabled={status === "awaiting_approval" || !input.trim()}
            >
              Send
            </button>
          )}
          <label className="ai-attach" title="Attach recent terminal output">
            <input
              type="checkbox"
              checked={attachOutput}
              onChange={(e) => setAttachOutput(e.currentTarget.checked)}
            />
            output
          </label>
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
}: {
  item: ChatItem;
  hostFor: (sid: number) => string;
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
              <div className="ai-text">{b.text}</div>
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
            return (
              <div key={i} className="ai-tooluse">
                ▸ ran on {typeof sid === "number" ? hostFor(sid) : "this host"}:{" "}
                <code>{b.input?.command}</code>
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
