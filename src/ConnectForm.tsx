import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  hasPassword: boolean;
}

interface Props {
  onConnected: (id: number, title: string) => void;
}

function ConnectForm({ onConnected }: Props) {
  const [saved, setSaved] = useState<SavedConnection[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [save, setSave] = useState(false);
  const [remember, setRemember] = useState(false);

  async function refresh() {
    try {
      setSaved(await invoke<SavedConnection[]>("connections_list"));
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function connectSaved(c: SavedConnection) {
    if (busyId) return;
    setBusyId(c.id);
    setError(null);
    setNotice(null);
    try {
      const id = await invoke<number>("ssh_connect_saved", { id: c.id });
      onConnected(id, c.name || `${c.user}@${c.host}`);
    } catch (err) {
      setError(`${c.name}: ${err}`);
    } finally {
      setBusyId(null);
    }
  }

  async function deleteSaved(c: SavedConnection) {
    if (confirmDeleteId !== c.id) {
      setConfirmDeleteId(c.id);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await invoke("connection_delete", { id: c.id });
      if (editingId === c.id) clearForm();
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  function editSaved(c: SavedConnection) {
    setEditingId(c.id);
    setName(c.name);
    setHost(c.host);
    setPort(String(c.port));
    setUser(c.user);
    setKeyPath(c.keyPath);
    setPassword("");
    setSave(true);
    setRemember(false);
  }

  function clearForm() {
    setEditingId(null);
    setName("");
    setHost("");
    setPort("22");
    setUser("");
    setPassword("");
    setKeyPath("");
    setSave(false);
    setRemember(false);
  }

  async function importLegacy() {
    setError(null);
    setNotice(null);
    try {
      const n = await invoke<number>("connections_import_legacy");
      setNotice(`Imported ${n} connection${n === 1 ? "" : "s"}.`);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setError(null);
    setNotice(null);
    try {
      const title = (save && name) || `${user}@${host}`;
      if (save) {
        const stored = await invoke<SavedConnection>("connection_save", {
          conn: {
            id: editingId ?? "",
            name: name || `${user}@${host}`,
            host,
            port: parseInt(port, 10) || 22,
            user,
            keyPath,
            hasPassword: false,
          },
          // Some(pw) stores, Some("") clears, null leaves untouched
          password: remember ? password : null,
        });
        setEditingId(stored.id);
        refresh();
      }
      const id = await invoke<number>("ssh_connect", {
        host,
        port: parseInt(port, 10) || 22,
        user,
        password: password || null,
        keyPath: keyPath || null,
      });
      onConnected(id, title);
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="connect-screen">
      <div className="connect-layout">
        <div className="saved-panel">
          <h2>Saved</h2>
          {saved.length === 0 && (
            <div className="saved-empty">No saved connections yet.</div>
          )}
          <ul className="saved-list">
            {saved.map((c) => (
              <li
                key={c.id}
                className={"saved-item" + (busyId === c.id ? " busy" : "")}
                onClick={() => connectSaved(c)}
              >
                <div className="saved-text">
                  <span className="saved-name">
                    {busyId === c.id ? "Connecting…" : c.name}
                  </span>
                  <span className="saved-detail">
                    {c.user}@{c.host}:{c.port}
                    {c.hasPassword ? " · password" : c.keyPath ? " · key" : ""}
                  </span>
                </div>
                <span className="saved-actions">
                  <button
                    type="button"
                    title="Edit"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(null);
                      editSaved(c);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className={
                      "saved-delete" +
                      (confirmDeleteId === c.id ? " confirming" : "")
                    }
                    title={
                      confirmDeleteId === c.id ? "Click again to delete" : "Delete"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSaved(c);
                    }}
                  >
                    {confirmDeleteId === c.id ? "sure?" : "×"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="link-btn" onClick={importLegacy}>
            Import from RemotePal (Python)…
          </button>
        </div>

        <form className="connect-form" onSubmit={connect}>
          <h1>RemotePal</h1>
          {editingId && (
            <div className="editing-note">
              Editing “{name}”
              <button type="button" className="link-btn" onClick={clearForm}>
                new connection
              </button>
            </div>
          )}
          <label>
            Host
            <input
              value={host}
              onChange={(e) => setHost(e.currentTarget.value)}
              placeholder="server.example.com"
              autoFocus
              required
            />
          </label>
          <div className="field-row">
            <label className="grow">
              User
              <input
                value={user}
                onChange={(e) => setUser(e.currentTarget.value)}
                placeholder="root"
                required
              />
            </label>
            <label className="port">
              Port
              <input
                value={port}
                onChange={(e) => setPort(e.currentTarget.value)}
                inputMode="numeric"
              />
            </label>
          </div>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              placeholder="(empty when using a key)"
            />
          </label>
          <label>
            Private key path
            <input
              value={keyPath}
              onChange={(e) => setKeyPath(e.currentTarget.value)}
              placeholder="C:\Users\me\.ssh\id_ed25519 (optional)"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={save}
              onChange={(e) => {
                setSave(e.currentTarget.checked);
                if (!e.currentTarget.checked) setRemember(false);
              }}
            />
            Save connection
          </label>
          {save && (
            <>
              <label>
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  placeholder={user && host ? `${user}@${host}` : "My server"}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.currentTarget.checked)}
                />
                Remember password (Windows Credential Manager)
              </label>
            </>
          )}
          <button type="submit" disabled={connecting}>
            {connecting ? "Connecting…" : "Connect"}
          </button>
          {error && <div className="connect-error">{error}</div>}
          {notice && <div className="connect-notice">{notice}</div>}
        </form>
      </div>
    </div>
  );
}

export default ConnectForm;
