import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { KeyRound } from "lucide-react";
import FileBrowser from "./FileBrowser";
import ForwardsPanel from "./ForwardsPanel";
import AiPanel from "./AiPanel";
import ServerInfoBar from "./ServerInfoBar";
import ComposeBar from "./ComposeBar";
import SnippetsPanel, {
  type LiveSession,
  type SessionMeta,
} from "./SnippetsPanel";
import { registerTerminal, unregisterTerminal } from "./terminalRegistry";
import { getTermTheme, subscribeTheme } from "./themes";
import { getTermFont, subscribeTermFont } from "./termFont";
import { arabicRuns } from "./arabicJoiner";
import "@xterm/xterm/css/xterm.css";

/// Password prompts we answer: sudo, su, and OpenSSH's own. Anchored to
/// the end of the output because the remote is sitting at the prompt
/// waiting for input when it matches.
const PASSWORD_PROMPT =
  /(?:\[sudo\]\s*password\s*for\s*\S+|\S+@\S+'s\s*password|password(?:\s*for\s*\S+)?)\s*:\s*$/i;

/// Strip ANSI escapes so styled prompts still match.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Props {
  id: number;
  active: boolean;
  /** this pane is its tab's focused pane (keyboard target) */
  focused: boolean;
  showFiles: boolean;
  showForwards: boolean;
  showSnippets: boolean;
  showAi: boolean;
  /** answer the remote's password prompts with the saved password */
  autoPassword: boolean;
  /** this tab has more than one pane, so this one can be closed on its own */
  canClosePane: boolean;
  meta: SessionMeta;
  savedConnId?: string;
  allSessions: LiveSession[];
  onFocus: () => void;
  onSplit: (dir: "row" | "column") => void;
  onClose: () => void;
  onDisconnected: () => void;
  onReconnected: (newId: number) => void;
}

function TerminalPane({
  id,
  active,
  focused,
  showFiles,
  showForwards,
  showSnippets,
  showAi,
  autoPassword,
  canClosePane,
  meta,
  savedConnId,
  allSessions,
  onFocus,
  onSplit,
  onClose,
  onDisconnected,
  onReconnected,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  // keep the session-lifetime effect independent of callback identity
  const onDisconnectedRef = useRef(onDisconnected);
  onDisconnectedRef.current = onDisconnected;
  const onSplitRef = useRef(onSplit);
  onSplitRef.current = onSplit;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [disconnected, setDisconnected] = useState(false);
  // read by the data handler, which is bound once per session
  const deadRef = useRef(false);
  const [pwNotice, setPwNotice] = useState<string | null>(null);
  // a write that goes nowhere is otherwise invisible: the terminal just
  // stops responding with no clue why
  const [writeError, setWriteError] = useState<string | null>(null);
  const writeFailedRef = useRef(false);

  // auto password answering: read through refs so the session-lifetime
  // effect doesn't need to re-run when the toggle flips
  const autoPasswordRef = useRef(autoPassword);
  autoPasswordRef.current = autoPassword;
  const savedConnIdRef = useRef(savedConnId);
  savedConnIdRef.current = savedConnId;
  /** tail of recent output, matched against the prompt pattern */
  const tailRef = useRef("");
  /** consecutive answers without the user typing — a wrong password
   *  would otherwise loop forever against a re-asking prompt */
  const pwTriesRef = useRef(0);
  const pwUntilRef = useRef(0);
  /** with auto off we offer to fill it in instead; these mirror the
   *  dialog state for the listener, which closes over refs only */
  const [pwAsk, setPwAsk] = useState(false);
  const pwAskRef = useRef(false);
  pwAskRef.current = pwAsk;
  const pwNeverAskRef = useRef(false);

  useEffect(() => {
    // a reconnect swaps in a new session id without remounting the pane
    // (paneId is stable on purpose), so clear the dead-session banner
    // here rather than leaving it up over a working terminal
    setDisconnected(false);
    setBannerError(null);
    setReconnecting(false);
    deadRef.current = false;
    writeFailedRef.current = false;
    setWriteError(null);

    // Tauri's unlisten resolves on a later tick, so an event for the
    // session this effect replaces can still arrive after it has set up.
    // Those handlers close over state shared with the pane, so without
    // this a stale close would mark the new session dead. Set
    // synchronously in the cleanup below.
    let live = true;

    const el = containerRef.current!;
    const term = new Terminal({
      theme: getTermTheme(),
      fontFamily: getTermFont(),
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openUrl(uri).catch(() => {});
      }),
    );
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    // expose this buffer to the AI panel's read_terminal tool
    registerTerminal(id, term);
    // draw Arabic-script runs as one unit so the text engine joins the
    // letters; only the WebGL renderer consults joiners, so this does
    // nothing on the DOM fallback below
    try {
      term.registerCharacterJoiner(arabicRuns);
    } catch {
      // older xterm without the joiner API: letters stay unjoined
    }
    import("@xterm/addon-webgl").then(({ WebglAddon }) => {
      try {
        term.loadAddon(new WebglAddon());
      } catch {
        // GPU unavailable: xterm falls back to the DOM renderer
      }
    });
    fit.fit();
    term.focus();

    // Ctrl+F opens search instead of reaching the shell;
    // Ctrl+Shift+D/E split the pane, Ctrl+Shift+W closes it
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && e.key === "f") {
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.select(), 0);
        return false;
      }
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === "d" || key === "e" || key === "w") {
          e.preventDefault();
          if (key === "d") onSplitRef.current("row");
          else if (key === "e") onSplitRef.current("column");
          else onCloseRef.current();
          return false;
        }
      }
      return true;
    });

    // Ctrl+wheel zooms the font
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const size = term.options.fontSize ?? 14;
      const next = Math.min(24, Math.max(6, size + (e.deltaY < 0 ? 1 : -1)));
      if (next !== size) {
        term.options.fontSize = next;
        fit.fit();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    const dataSub = term.onData((data) => {
      // xterm's disableStdin should have stopped this, but never write to
      // a session we already know has ended
      if (deadRef.current) return;
      // the user taking over resets the wrong-password guard
      pwTriesRef.current = 0;
      setPwNotice(null);
      invoke("ssh_write", { id, data })
        .then(() => {
          if (writeFailedRef.current) {
            writeFailedRef.current = false;
            setWriteError(null);
          }
        })
        .catch((err) => {
          if (writeFailedRef.current) return; // one message, not one per key
          writeFailedRef.current = true;
          setWriteError(`Could not send to this session: ${err}`);
        });
    });

    /// Watch output for a password prompt and answer it from the saved
    /// credential. The password itself lives in the backend — we only
    /// tell it which connection to use.
    const decoder = new TextDecoder();
    function maybeAnswerPassword(bytes: Uint8Array) {
      const connId = savedConnIdRef.current;
      // nothing to offer without a saved password to send
      if (!connId) return;
      if (!autoPasswordRef.current && pwNeverAskRef.current) return;

      tailRef.current = (
        tailRef.current + stripAnsi(decoder.decode(bytes, { stream: true }))
      ).slice(-200);

      const line = tailRef.current.split("\n").pop() ?? "";
      if (!PASSWORD_PROMPT.test(line)) return;
      if (Date.now() < pwUntilRef.current) return; // still settling

      // auto off: offer it rather than typing it unasked
      if (!autoPasswordRef.current) {
        if (!pwAskRef.current) {
          tailRef.current = "";
          setPwAsk(true);
        }
        return;
      }

      if (pwTriesRef.current >= 2) {
        setPwNotice(
          "Saved password was not accepted — type it yourself, or turn auto password off.",
        );
        return;
      }
      pwTriesRef.current += 1;
      pwUntilRef.current = Date.now() + 1500;
      tailRef.current = "";
      invoke("ssh_send_saved_password", { id, connId }).catch((err) =>
        setPwNotice(String(err)),
      );
    }
    const resizeSub = term.onResize(({ cols, rows }) => {
      invoke("ssh_resize", { id, cols, rows }).catch(() => {});
    });
    invoke("ssh_resize", { id, cols: term.cols, rows: term.rows }).catch(
      () => {},
    );

    const unlisteners: Promise<UnlistenFn>[] = [
      listen<string>(`ssh-data-${id}`, (e) => {
        if (!live) return;
        const bytes = base64ToBytes(e.payload);
        term.write(bytes);
        maybeAnswerPassword(bytes);
      }),
      listen(`ssh-closed-${id}`, () => {
        // a close belonging to a session this pane has already moved past
        // must not mark the current one dead
        if (!live) return;
        // a blinking cursor reads as "waiting for you to type" — stop it
        // and refuse input, so a dead session cannot be mistaken for live
        term.options.cursorBlink = false;
        term.options.disableStdin = true;
        deadRef.current = true;
        setDisconnected(true);
        onDisconnectedRef.current();
      }),
    ];

    // hidden tabs have zero size; fitting then would corrupt the grid
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
    });
    observer.observe(el);

    return () => {
      live = false;
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
      dataSub.dispose();
      resizeSub.dispose();
      unlisteners.forEach((p) => p.then((un) => un()));
      invoke("ssh_disconnect", { id }).catch(() => {});
      unregisterTerminal(id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    const el = containerRef.current;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      fitRef.current?.fit();
    }
    if (focused) termRef.current?.focus();
  }, [active, focused]);

  useEffect(() => {
    return subscribeTheme(() => {
      const term = termRef.current;
      if (term) term.options.theme = getTermTheme();
    });
  }, []);

  useEffect(() => {
    return subscribeTermFont(() => {
      const term = termRef.current;
      if (term) {
        term.options.fontFamily = getTermFont();
        fitRef.current?.fit();
      }
    });
  }, []);

  async function reconnect() {
    setReconnecting(true);
    setBannerError(null);
    try {
      const newId = await invoke<number>("ssh_reconnect", { id });
      onReconnected(newId);
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      setBannerError(
        e?.kind === "hostKeyUnknown" || e?.kind === "hostKeyChanged"
          ? "Host key needs review — reconnect from the connect screen."
          : (e?.message ?? String(err)),
      );
    } finally {
      setReconnecting(false);
    }
  }

  /// Close the password dialog and put the caret back in the terminal —
  /// focus is on the dialog's button, so it would otherwise land on the
  /// document and the next keystroke would go nowhere. Deferred so the
  /// modal has unmounted before we take focus back.
  function closePwAsk() {
    setPwAsk(false);
    setTimeout(() => termRef.current?.focus(), 0);
  }

  /// Fill in the saved password for the prompt the remote is sitting at.
  function sendSavedPassword() {
    closePwAsk();
    pwUntilRef.current = Date.now() + 1500;
    if (!savedConnId) return;
    invoke("ssh_send_saved_password", { id, connId: savedConnId }).catch((err) =>
      setPwNotice(String(err)),
    );
  }

  function findInTerm(backward: boolean) {
    if (!searchQuery) return;
    if (backward) searchRef.current?.findPrevious(searchQuery);
    else searchRef.current?.findNext(searchQuery);
  }

  return (
    <div
      className={"term-pane" + (focused ? " focused" : "")}
      onMouseDownCapture={onFocus}
    >
      {disconnected && (
        <div className="term-banner">
          <span>
            Session disconnected.
            {bannerError ? ` ${bannerError}` : ""}
          </span>
          <button
            className={reconnecting ? "loading" : ""}
            onClick={reconnect}
            disabled={reconnecting}
          >
            {reconnecting ? "Reconnecting…" : "Reconnect"}
          </button>
          <button onClick={onClose}>Close pane</button>
        </div>
      )}
      {searchOpen && (
        <div className="term-search">
          <input
            ref={searchInputRef}
            autoFocus
            value={searchQuery}
            placeholder="Find…  (Enter: next, Shift+Enter: previous, Esc: close)"
            onChange={(e) => {
              setSearchQuery(e.currentTarget.value);
              searchRef.current?.findNext(e.currentTarget.value, {
                incremental: true,
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") findInTerm(e.shiftKey);
              if (e.key === "Escape") {
                setSearchOpen(false);
                searchRef.current?.clearDecorations();
                termRef.current?.focus();
              }
            }}
          />
          <button type="button" title="Previous" onClick={() => findInTerm(true)}>
            ↑
          </button>
          <button type="button" title="Next" onClick={() => findInTerm(false)}>
            ↓
          </button>
          <button
            type="button"
            title="Close"
            onClick={() => {
              setSearchOpen(false);
              searchRef.current?.clearDecorations();
              termRef.current?.focus();
            }}
          >
            ×
          </button>
        </div>
      )}
      {pwAsk && (
        <div className="modal-overlay" onMouseDown={closePwAsk}>
          <div className="pw-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="pw-dialog-head">
              <KeyRound size={16} />
              <h3>Send saved password?</h3>
            </div>
            <p className="pw-dialog-body">
              <strong>
                {meta.user}@{meta.host}
              </strong>{" "}
              is asking for a password. Send the one saved for this
              connection?
            </p>
            <div className="pw-dialog-buttons">
              <button
                type="button"
                className="link-btn"
                title="Stop offering this for the rest of this session"
                onClick={() => {
                  pwNeverAskRef.current = true;
                  closePwAsk();
                }}
              >
                Don't ask again
              </button>
              <button type="button" onClick={closePwAsk}>
                Not now
              </button>
              <button
                type="button"
                className="accent-btn"
                autoFocus
                onClick={sendSavedPassword}
              >
                Send password
              </button>
            </div>
          </div>
        </div>
      )}
      {writeError && <div className="files-error">{writeError}</div>}
      {pwNotice && <div className="files-error">{pwNotice}</div>}
      {showSnippets && (
        <SnippetsPanel sessionId={id} meta={meta} allSessions={allSessions} />
      )}
      {showForwards && (
        <ForwardsPanel sessionId={id} savedConnId={savedConnId} />
      )}
      <ServerInfoBar
        sessionId={id}
        meta={meta}
        active={active && !disconnected}
        onClose={canClosePane ? onClose : undefined}
      />
      <div className="term-row">
        <div ref={containerRef} className="term-container" />
        {showFiles && <FileBrowser sessionId={id} active={active} />}
        {showAi && (
          <AiPanel sessionId={id} meta={meta} allSessions={allSessions} />
        )}
      </div>
      <ComposeBar sessionId={id} disabled={disconnected} />
    </div>
  );
}

export default TerminalPane;
