// A local shell in a terminal tab. Same xterm setup as the SSH pane but
// wired to the local PTY commands (local_open/write/resize/close) and the
// `local-data-{id}` events instead of the SSH ones.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getTermTheme, subscribeTheme } from "./themes";
import OsIcon, { osLabel } from "./osIcons";
import { TerminalSquare } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface LocalInfo {
  os: string;
  user: string;
  host: string;
  shell: string;
}

interface Props {
  active: boolean;
  shell?: string;
  onExit: () => void;
}

function LocalTerminal({ active, shell, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [info, setInfo] = useState<LocalInfo | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

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
    term.loadAddon(new SearchAddon());
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openUrl(uri).catch(() => {});
      }),
    );
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    import("@xterm/addon-webgl").then(({ WebglAddon }) => {
      try {
        term.loadAddon(new WebglAddon());
      } catch {
        // GPU unavailable: xterm falls back to the DOM renderer
      }
    });
    fit.fit();
    term.focus();

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

    let id: number | null = null;
    let disposed = false;
    const unlisteners: Promise<UnlistenFn>[] = [];

    invoke<number>("local_open", {
      cols: term.cols,
      rows: term.rows,
      shell,
    })
      .then((sid) => {
        if (disposed) {
          invoke("local_close", { id: sid }).catch(() => {});
          return;
        }
        id = sid;
        unlisteners.push(
          listen<string>(`local-data-${sid}`, (e) =>
            term.write(base64ToBytes(e.payload)),
          ),
          listen(`local-closed-${sid}`, () => {
            setExited(true);
            onExitRef.current();
          }),
        );
        term.onData((data) => {
          invoke("local_write", { id: sid, data }).catch(() => {});
        });
        term.onResize(({ cols, rows }) => {
          invoke("local_resize", { id: sid, cols, rows }).catch(() => {});
        });
      })
      .catch((err) => setError(String(err)));

    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
    });
    observer.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
      unlisteners.forEach((p) => p.then((un) => un()));
      if (id !== null) invoke("local_close", { id }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [shell]);

  useEffect(() => {
    if (!active) return;
    const el = containerRef.current;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) fitRef.current?.fit();
    termRef.current?.focus();
  }, [active]);

  useEffect(() => {
    invoke<LocalInfo>("local_info").then(setInfo).catch(() => {});
  }, []);

  useEffect(() => {
    return subscribeTheme(() => {
      const term = termRef.current;
      if (term) term.options.theme = getTermTheme();
    });
  }, []);

  return (
    <div className="term-pane">
      {info && (
        <div className="server-info">
          <span
            className="si-host"
            title={`${info.user}@${info.host} — ${osLabel(info.os)}`}
          >
            <OsIcon os={info.os} size={14} />
            {info.user}@{info.host}
          </span>
          <span className="si-item" title="Shell">
            <TerminalSquare size={12} className="si-icon" />
            {info.shell}
          </span>
          <span className="si-dim">local</span>
        </div>
      )}
      {exited && <div className="term-banner">Shell exited.</div>}
      {error && <div className="files-error">{error}</div>}
      <div className="term-row">
        <div ref={containerRef} className="term-container" />
      </div>
    </div>
  );
}

export default LocalTerminal;
