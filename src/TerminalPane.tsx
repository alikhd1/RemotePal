import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import FileBrowser from "./FileBrowser";
import ForwardsPanel from "./ForwardsPanel";
import AiPanel from "./AiPanel";
import SnippetsPanel, {
  type LiveSession,
  type SessionMeta,
} from "./SnippetsPanel";
import { registerTerminal, unregisterTerminal } from "./terminalRegistry";
import { getTermTheme, subscribeTheme } from "./themes";
import "@xterm/xterm/css/xterm.css";

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

  useEffect(() => {
    const el = containerRef.current!;
    const term = new Terminal({
      theme: getTermTheme(),
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
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
      invoke("ssh_write", { id, data }).catch(() => {});
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      invoke("ssh_resize", { id, cols, rows }).catch(() => {});
    });
    invoke("ssh_resize", { id, cols: term.cols, rows: term.rows }).catch(
      () => {},
    );

    const unlisteners: Promise<UnlistenFn>[] = [
      listen<string>(`ssh-data-${id}`, (e) =>
        term.write(base64ToBytes(e.payload)),
      ),
      listen(`ssh-closed-${id}`, () => {
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
          <button onClick={reconnect} disabled={reconnecting}>
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
      {showSnippets && (
        <SnippetsPanel sessionId={id} meta={meta} allSessions={allSessions} />
      )}
      {showForwards && (
        <ForwardsPanel sessionId={id} savedConnId={savedConnId} />
      )}
      <div className="term-row">
        <div ref={containerRef} className="term-container" />
        {showFiles && <FileBrowser sessionId={id} active={active} />}
        {showAi && (
          <AiPanel sessionId={id} meta={meta} allSessions={allSessions} />
        )}
      </div>
    </div>
  );
}

export default TerminalPane;
