import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import FileBrowser from "./FileBrowser";
import "@xterm/xterm/css/xterm.css";

// One Dark, carried over from the PyQt app
const THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  black: "#3f3f3f",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#d19a66",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d4d4d4",
  brightBlack: "#7f848e",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Props {
  id: number;
  active: boolean;
  showFiles: boolean;
  onClose: () => void;
  onDisconnected: () => void;
}

function TerminalPane({ id, active, showFiles, onClose, onDisconnected }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // keep the session-lifetime effect independent of callback identity
  const onDisconnectedRef = useRef(onDisconnected);
  onDisconnectedRef.current = onDisconnected;
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    const el = containerRef.current!;
    const term = new Terminal({
      theme: THEME,
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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
      dataSub.dispose();
      resizeSub.dispose();
      unlisteners.forEach((p) => p.then((un) => un()));
      invoke("ssh_disconnect", { id }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    const el = containerRef.current;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      fitRef.current?.fit();
    }
    termRef.current?.focus();
  }, [active]);

  return (
    <div className="term-pane">
      {disconnected && (
        <div className="term-banner">
          <span>Session disconnected.</span>
          <button onClick={onClose}>Close tab</button>
        </div>
      )}
      <div className="term-row">
        <div ref={containerRef} className="term-container" />
        {showFiles && <FileBrowser sessionId={id} active={active} />}
      </div>
    </div>
  );
}

export default TerminalPane;
