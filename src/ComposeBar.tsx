// A command composer docked at the bottom of a terminal. Collapsed it is
// a thin clickable strip; clicking opens an editable area where you can
// write and revise a command (multi-line supported) before sending it to
// the session — handy for long pipelines you don't want to mistype live
// at the prompt. As you type it suggests completions drawn from the
// app's command history, your saved snippets, and a small list of common
// commands. Sent commands are recorded in the history.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, SendHorizontal, TerminalSquare } from "lucide-react";
import { getHistory, pushHistory } from "./commandHistory";

interface Props {
  sessionId: number;
  /** session is gone — composing would go nowhere */
  disabled?: boolean;
}

interface Suggestion {
  value: string;
  /** where it came from, shown dim on the right */
  source: string;
}

const MAX_SUGGESTIONS = 8;

const SUGGEST_KEY = "remotepal-compose-suggest";

function suggestEnabled(): boolean {
  return localStorage.getItem(SUGGEST_KEY) !== "0";
}

/// Commands whose next argument is a path worth completing.
const PATH_COMMANDS = new Set([
  "cd", "ls", "ll", "cat", "less", "more", "tail", "head", "vi", "vim",
  "nano", "rm", "cp", "mv", "touch", "mkdir", "rmdir", "chmod", "chown",
  "du", "stat", "source", "tar", "unzip", "zip", "scp", "rsync",
]);

const COMMON_COMMANDS = [
  "df -h",
  "du -sh *",
  "free -h",
  "htop",
  "journalctl -u ",
  "journalctl -xe",
  "ls -la",
  "netstat -tulpn",
  "ps aux --sort=-%cpu | head -20",
  "systemctl restart ",
  "systemctl status ",
  "tail -f /var/log/syslog",
  "uname -a",
  "uptime",
];

function ComposeBar({ sessionId, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // index into history for ↑/↓ recall; -1 means "editing a fresh command"
  const [histIdx, setHistIdx] = useState(-1);
  const [snippets, setSnippets] = useState<string[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestOn, setSuggestOn] = useState(suggestEnabled());
  /// remote directory entries for the path currently being typed
  const [pathHits, setPathHits] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) taRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    invoke<{ name: string; command: string }[]>("snippets_list")
      .then((list) => setSnippets(list.map((s) => s.command)))
      .catch(() => {});
  }, [open]);

  // suggestions match the last line, so a multi-line draft still completes
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);

  // The token being typed and the command in front of it decide whether a
  // remote directory listing is worth fetching.
  const words = lastLine.split(/\s+/);
  const token = words[words.length - 1] ?? "";
  const verb = words.length > 1 ? words[0] : "";
  const wantsPath =
    suggestOn &&
    (token.startsWith("/") ||
      token.startsWith("./") ||
      token.startsWith("~/") ||
      (words.length > 1 && PATH_COMMANDS.has(verb)));

  useEffect(() => {
    if (!open || !wantsPath || disabled) {
      setPathHits([]);
      return;
    }
    // list the directory the token points into, then filter by its tail
    const cut = token.lastIndexOf("/");
    const dir = cut < 0 ? "." : token.slice(0, cut + 1) || "/";
    const tail = token.slice(cut + 1).toLowerCase();
    const head = lastLine.slice(0, lastLine.length - token.length);
    let cancelled = false;
    // debounce: typing a path should not list on every keystroke
    const timer = window.setTimeout(() => {
      invoke<{ name: string; isDir: boolean }[]>("sftp_list", {
        id: sessionId,
        path: dir,
      })
        .then((list) => {
          if (cancelled) return;
          setPathHits(
            list
              .filter((e) => e.name.toLowerCase().startsWith(tail))
              .slice(0, MAX_SUGGESTIONS)
              .map((e) => ({
                value:
                  head +
                  (dir === "." ? "" : dir) +
                  e.name +
                  (e.isDir ? "/" : ""),
                source: e.isDir ? "folder" : "file",
              })),
          );
        })
        .catch(() => {
          if (!cancelled) setPathHits([]);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, wantsPath, token, sessionId, lastLine, disabled]);


  const suggestions = useMemo<Suggestion[]>(() => {
    if (!suggestOn) return [];
    // a path being typed is a better answer than anything from history
    if (pathHits.length > 0) return pathHits;
    const q = lastLine.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    const consider = (value: string, source: string) => {
      const v = value.trim();
      if (!v || v.toLowerCase() === q) return;
      if (seen.has(v)) return;
      if (!v.toLowerCase().includes(q)) return;
      seen.add(v);
      out.push({ value: v, source });
    };
    // history first (most relevant), then snippets, then common commands
    getHistory().forEach((c) => consider(c, "history"));
    snippets.forEach((c) => consider(c, "snippet"));
    COMMON_COMMANDS.forEach((c) => consider(c, "common"));
    // prefix matches rank above substring matches
    return out
      .sort((a, b) => {
        const ap = a.value.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.value.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp;
      })
      .slice(0, MAX_SUGGESTIONS);
  }, [lastLine, snippets, suggestOn, pathHits]);

  const showSuggest = suggestOpen && suggestions.length > 0;

  function applySuggestion(s: Suggestion) {
    // replace only the last line, keeping any earlier lines intact
    const head = text.slice(0, text.lastIndexOf("\n") + 1);
    setText(head + s.value);
    setSuggestOpen(false);
    setHighlight(0);
    taRef.current?.focus();
  }

  async function send() {
    const cmd = text.trim();
    // Enter reaches here without going through the Send button, so the
    // dead-session check has to live in the action, not just the control
    if (!cmd || disabled) return;
    try {
      await invoke("ssh_write", {
        id: sessionId,
        data: text.replace(/\r\n/g, "\n") + "\n",
      });
      pushHistory(cmd);
      setText("");
      setHistIdx(-1);
      setSuggestOpen(false);
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
    // the suggestion list takes over the arrows/Tab/Enter while it's open
    if (showSuggest) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        applySuggestion(suggestions[highlight] ?? suggestions[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestOpen(false); // first Esc dismisses suggestions only
        return;
      }
    }

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
      <div className="compose-field">
        {showSuggest && (
          <div className="compose-suggest" role="listbox">
            {suggestions.map((s, i) => (
              <div
                key={s.value}
                role="option"
                aria-selected={i === highlight}
                className={"compose-suggest-item" + (i === highlight ? " active" : "")}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the textarea
                  applySuggestion(s);
                }}
              >
                <span className="compose-suggest-cmd">{s.value}</span>
                <span className="compose-suggest-src">{s.source}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          className="compose-input"
          value={text}
          rows={3}
          spellCheck={false}
          disabled={disabled}
          placeholder={
            "Write a command, then Enter to send (Shift+Enter for a new line, ↑ for history, Tab to complete)"
          }
          onChange={(e) => {
            setText(e.currentTarget.value);
            setSuggestOpen(true);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setSuggestOpen(false)}
        />
      </div>
      <div className="compose-actions">
        <label className="compose-toggle" title="Suggest completions as you type">
          <input
            type="checkbox"
            checked={suggestOn}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              localStorage.setItem(SUGGEST_KEY, on ? "1" : "0");
              setSuggestOn(on);
              if (!on) setSuggestOpen(false);
            }}
          />
          suggest
        </label>
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
