import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu, { type MenuItem } from "./ContextMenu";

export interface Snippet {
  name: string;
  command: string;
}

export interface SessionMeta {
  host: string;
  user: string;
  port: number;
  name: string;
}

export interface LiveSession {
  id: number;
  meta: SessionMeta;
}

interface Props {
  sessionId: number;
  meta: SessionMeta;
  allSessions: LiveSession[];
}

function placeholders(command: string): string[] {
  return [...new Set([...command.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
}

function substitute(command: string, values: Record<string, string>): string {
  return command.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in values ? values[name] : all,
  );
}

function SnippetsPanel({ sessionId, meta, allSessions }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editCommand, setEditCommand] = useState("");
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    idx: number;
  } | null>(null);
  const [varPrompt, setVarPrompt] = useState<{
    command: string;
    vars: string[];
    values: Record<string, string>;
    toAll: boolean;
  } | null>(null);

  async function refresh() {
    try {
      setSnippets(await invoke<Snippet[]>("snippets_list"));
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function contextFor(m: SessionMeta): Record<string, string> {
    return {
      host: m.host,
      user: m.user,
      port: String(m.port),
      name: m.name,
    };
  }

  async function doSend(
    command: string,
    custom: Record<string, string>,
    toAll: boolean,
  ) {
    const targets = toAll ? allSessions : [{ id: sessionId, meta }];
    try {
      for (const target of targets) {
        // built-ins resolve per target session; prompted values shared
        const resolved = substitute(command, {
          ...contextFor(target.meta),
          ...custom,
        });
        await invoke("ssh_write", {
          id: target.id,
          data: resolved.replace(/\r\n/g, "\n") + "\n",
        });
      }
    } catch (err) {
      setError(String(err));
    }
  }

  function send(snippet: Snippet, toAll: boolean) {
    setConfirmIdx(null);
    const unknown = placeholders(snippet.command).filter(
      (v) => !(v in contextFor(meta)),
    );
    if (unknown.length) {
      setVarPrompt({
        command: snippet.command,
        vars: unknown,
        values: Object.fromEntries(unknown.map((v) => [v, ""])),
        toAll,
      });
      return;
    }
    doSend(snippet.command, {}, toAll);
  }

  async function persist(next: Snippet[]) {
    try {
      await invoke("snippets_save", { snippets: next });
      setSnippets(next);
    } catch (err) {
      setError(String(err));
    }
  }

  function startEdit(idx: number | "new") {
    setEditing(idx);
    if (idx === "new") {
      setEditName("");
      setEditCommand("");
    } else {
      setEditName(snippets[idx].name);
      setEditCommand(snippets[idx].command);
    }
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editName.trim() || !editCommand.trim()) return;
    const snippet = { name: editName.trim(), command: editCommand };
    const next =
      editing === "new"
        ? [...snippets, snippet]
        : snippets.map((s, i) => (i === editing ? snippet : s));
    await persist(next);
    setEditing(null);
  }

  async function remove(idx: number) {
    if (confirmIdx !== idx) {
      setConfirmIdx(idx);
      return;
    }
    setConfirmIdx(null);
    await persist(snippets.filter((_, i) => i !== idx));
  }

  return (
    <div className="forwards-panel">
      <div className="forwards-title">
        Snippets
        <button
          type="button"
          className="link-btn snippets-add"
          onClick={() => startEdit("new")}
        >
          add…
        </button>
      </div>
      <div className="forwards-list">
        {snippets.map((snippet, idx) => (
          <div
            key={`${snippet.name}-${idx}`}
            className="forwards-row"
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, idx });
            }}
          >
            <span
              className="snippet-desc"
              title={`${snippet.command}\n\nClick to run in this terminal; right-click for more`}
              onClick={() => send(snippet, false)}
            >
              <strong>{snippet.name}</strong>
              <span className="snippet-cmd">
                {snippet.command.split("\n")[0]}
                {snippet.command.includes("\n") ? " …" : ""}
              </span>
            </span>
            <span>
              <button
                type="button"
                title={confirmIdx === idx ? "Click again to delete" : "Delete"}
                onClick={() => remove(idx)}
              >
                {confirmIdx === idx ? "sure?" : "×"}
              </button>
            </span>
          </div>
        ))}
        {snippets.length === 0 && editing === null && (
          <div className="files-empty">
            No snippets yet. Variables: {"{host} {user} {port} {name}"} fill in
            from the session; any other {"{placeholder}"} asks on send.
          </div>
        )}
      </div>
      {editing !== null && (
        <form className="snippet-edit" onSubmit={submitEdit}>
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.currentTarget.value)}
            placeholder="name"
          />
          <textarea
            value={editCommand}
            onChange={(e) => setEditCommand(e.currentTarget.value)}
            placeholder={"command — multi-line runs line by line\n{host} {user} {port} {name} or custom {placeholder}"}
            rows={3}
            spellCheck={false}
          />
          <div className="dialog-buttons">
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="accent-btn">
              Save
            </button>
          </div>
        </form>
      )}
      {varPrompt && (
        <form
          className="snippet-edit"
          onSubmit={(e) => {
            e.preventDefault();
            doSend(varPrompt.command, varPrompt.values, varPrompt.toAll);
            setVarPrompt(null);
          }}
        >
          {varPrompt.vars.map((v, i) => (
            <label key={v} className="snippet-var">
              {"{" + v + "}"}
              <input
                autoFocus={i === 0}
                value={varPrompt.values[v]}
                onChange={(e) =>
                  setVarPrompt({
                    ...varPrompt,
                    values: { ...varPrompt.values, [v]: e.currentTarget.value },
                  })
                }
              />
            </label>
          ))}
          <div className="dialog-buttons">
            <button type="button" onClick={() => setVarPrompt(null)}>
              Cancel
            </button>
            <button type="submit" className="accent-btn">
              {varPrompt.toAll ? `Run in all (${allSessions.length})` : "Run"}
            </button>
          </div>
        </form>
      )}
      {error && <div className="files-error">{error}</div>}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={
            [
              {
                label: "Send to this session",
                onClick: () => send(snippets[ctxMenu.idx], false),
              },
              {
                label: `Send to ALL sessions (${allSessions.length})`,
                onClick: () => send(snippets[ctxMenu.idx], true),
              },
              { label: "", separator: true },
              { label: "Edit…", onClick: () => startEdit(ctxMenu.idx) },
              {
                label: "Delete…",
                danger: true,
                onClick: () => setConfirmIdx(ctxMenu.idx),
              },
            ] satisfies MenuItem[]
          }
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

export default SnippetsPanel;
