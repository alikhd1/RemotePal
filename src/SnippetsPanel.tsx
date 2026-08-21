import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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

interface Props {
  sessionId: number;
  meta: SessionMeta;
}

function placeholders(command: string): string[] {
  return [...new Set([...command.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
}

function substitute(command: string, values: Record<string, string>): string {
  return command.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in values ? values[name] : all,
  );
}

function SnippetsPanel({ sessionId, meta }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editCommand, setEditCommand] = useState("");
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);
  const [varPrompt, setVarPrompt] = useState<{
    command: string;
    vars: string[];
    values: Record<string, string>;
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

  function builtinContext(): Record<string, string> {
    return {
      host: meta.host,
      user: meta.user,
      port: String(meta.port),
      name: meta.name,
    };
  }

  async function doSend(command: string) {
    try {
      await invoke("ssh_write", {
        id: sessionId,
        data: command.replace(/\r\n/g, "\n") + "\n",
      });
    } catch (err) {
      setError(String(err));
    }
  }

  function send(snippet: Snippet) {
    setConfirmIdx(null);
    const context = builtinContext();
    const unknown = placeholders(snippet.command).filter(
      (v) => !(v in context),
    );
    if (unknown.length) {
      setVarPrompt({
        command: snippet.command,
        vars: unknown,
        values: Object.fromEntries(unknown.map((v) => [v, ""])),
      });
      return;
    }
    doSend(substitute(snippet.command, context));
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
          <div key={`${snippet.name}-${idx}`} className="forwards-row">
            <span
              className="snippet-desc"
              title={`${snippet.command}\n\nClick to run in this terminal`}
              onClick={() => send(snippet)}
            >
              <strong>{snippet.name}</strong>
              <span className="snippet-cmd">
                {snippet.command.split("\n")[0]}
                {snippet.command.includes("\n") ? " …" : ""}
              </span>
            </span>
            <span>
              <button type="button" title="Edit" onClick={() => startEdit(idx)}>
                ✎
              </button>
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
            doSend(
              substitute(varPrompt.command, {
                ...builtinContext(),
                ...varPrompt.values,
              }),
            );
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
              Run
            </button>
          </div>
        </form>
      )}
      {error && <div className="files-error">{error}</div>}
    </div>
  );
}

export default SnippetsPanel;
