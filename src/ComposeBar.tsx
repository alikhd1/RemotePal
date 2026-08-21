// A command composer docked at the bottom of a terminal. Collapsed it is
// a thin clickable strip; clicking opens an editable area where you can
// write and revise a command (multi-line supported) before sending it to
// the session — handy for long pipelines you don't want to mistype live
// at the prompt. Sent commands are recorded in the app's command history.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, SendHorizontal, TerminalSquare } from "lucide-react";
import { getHistory, pushHistory } from "./commandHistory";

interface Props {
  sessionId: number;
  /** session is gone — composing would go nowhere */
  disabled?: boolean;
}

function ComposeBar({ sessionId, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // index into history for ↑/↓ recall; -1 means "editing a fresh command"
  const [histIdx, setHistIdx] = useState(-1);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) taRef.current?.focus();
  }, [open]);

  async function send() {
    const cmd = text.trim();
    if (!cmd) return;
    try {
      await invoke("ssh_write", {
        id: sessionId,
        data: text.replace(/\r\n/g, "\n") + "\n",
      });
      pushHistory(cmd);
      setText("");
      setHistIdx(-1);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  function recall(step: 1 | -1) {
    const hist = getHistory();
    if (hist.length === 0) return;
    const next = Math.min(hist.length - 1, Math.max(-1, histIdx + step));
    setHistIdx(next);
    setText(next === -1 ? "" : hist[next]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    // ↑/↓ recall only when the caret is on the first/last line, so they
    // still move within a multi-line draft
    const ta = e.currentTarget;
    if (e.key === "ArrowUp" && ta.selectionStart === 0) {
      e.preventDefault();
      recall(1);
    } else if (e.key === "ArrowDown" && ta.selectionEnd === ta.value.length) {
      e.preventDefault();
      recall(-1);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="compose-collapsed"
        title="Compose a command before sending it"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <TerminalSquare size={13} />
        Compose command…
      </button>
    );
  }

  return (
    <div className="compose-bar">
      <textarea
        ref={taRef}
        className="compose-input"
        value={text}
        rows={3}
        spellCheck={false}
        placeholder={
          "Write a command, then Enter to send (Shift+Enter for a new line, ↑ for history)"
        }
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className="compose-actions">
        <button
          type="button"
          className="link-btn"
          title="Close composer (Esc)"
          onClick={() => setOpen(false)}
        >
          <ChevronDown size={13} />
          Close
        </button>
        <button
          type="button"
          className="accent-btn"
          disabled={!text.trim() || disabled}
          title="Send to the terminal (Enter)"
          onClick={send}
        >
          <SendHorizontal size={13} />
          Send
        </button>
      </div>
      {error && <div className="files-error">{error}</div>}
    </div>
  );
}

export default ComposeBar;
