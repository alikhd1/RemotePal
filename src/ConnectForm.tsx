import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import S3Storages from "./S3Storages";
import VaultCard from "./VaultCard";
import KeysCard, { type VaultKey } from "./KeysCard";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import type { SessionMeta } from "./SnippetsPanel";

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  hasPassword: boolean;
  jump: string;
}

export interface HostKeyIssue {
  kind: "hostKeyUnknown" | "hostKeyChanged";
  host: string;
  port: number;
  fingerprint: string;
  keyOpenssh: string;
}

function asHostKeyIssue(err: unknown): HostKeyIssue | null {
  if (
    err &&
    typeof err === "object" &&
    "kind" in err &&
    (err.kind === "hostKeyUnknown" || err.kind === "hostKeyChanged")
  ) {
    return err as HostKeyIssue;
  }
  return null;
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

interface Props {
  onConnected: (
    id: number,
    title: string,
    meta: SessionMeta,
    opts?: { openFiles?: boolean },
  ) => void;
  onOpenS3: (storageId: string, title: string) => void;
}

function ConnectForm({ onConnected, onOpenS3 }: Props) {
  const [importBump, setImportBump] = useState(0);
  const [saved, setSaved] = useState<SavedConnection[]>([]);
  const [vaultKeys, setVaultKeys] = useState<VaultKey[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<{
    issue: HostKeyIssue;
    retry: () => void;
  } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    conn: SavedConnection;
  } | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [jump, setJump] = useState("");
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
    invoke<VaultKey[]>("keys_list")
      .then(setVaultKeys)
      .catch(() => {});
  }, []);

  async function connectSaved(
    c: SavedConnection,
    opts?: { openFiles?: boolean },
  ) {
    if (busyId) return;
    setBusyId(c.id);
    setError(null);
    setNotice(null);
    try {
      const id = await invoke<number>("ssh_connect_saved", { id: c.id });
      onConnected(
        id,
        c.name || `${c.user}@${c.host}`,
        {
          host: c.host,
          user: c.user,
          port: c.port,
          name: c.name || `${c.user}@${c.host}`,
        },
        opts,
      );
    } catch (err) {
      const issue = asHostKeyIssue(err);
      if (issue) {
        setHostKeyPrompt({ issue, retry: () => connectSaved(c) });
      } else {
        setError(`${c.name}: ${errMessage(err)}`);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function trustAndRetry() {
    if (!hostKeyPrompt) return;
    const { issue, retry } = hostKeyPrompt;
    setHostKeyPrompt(null);
    try {
      await invoke("trust_host_key", {
        host: issue.host,
        port: issue.port,
        keyOpenssh: issue.keyOpenssh,
      });
    } catch (err) {
      setError(errMessage(err));
      return;
    }
    retry();
  }

  async function deployKey(c: SavedConnection) {
    const pub = await openDialog({
      multiple: false,
      title: `Deploy which public key to ${c.name || c.host}?`,
      defaultPath: c.keyPath ? `${c.keyPath}.pub` : undefined,
      filters: [{ name: "OpenSSH public key", extensions: ["pub"] }],
    });
    if (typeof pub !== "string") return;
    doDeploy(c, pub);
  }

  async function doDeploy(c: SavedConnection, pubKeyPath: string) {
    setBusyId(c.id);
    setError(null);
    setNotice(null);
    try {
      await invoke("deploy_key", { id: c.id, pubKeyPath });
      setNotice(
        `Public key deployed to ${c.name || c.host} — key auth should work now.`,
      );
    } catch (err) {
      const issue = asHostKeyIssue(err);
      if (issue) {
        setHostKeyPrompt({ issue, retry: () => doDeploy(c, pubKeyPath) });
      } else {
        setError(`${c.name}: ${errMessage(err)}`);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function forgetPassword(c: SavedConnection) {
    setError(null);
    try {
      await invoke("connection_save", {
        conn: {
          id: c.id,
          name: c.name,
          host: c.host,
          port: c.port,
          user: c.user,
          keyPath: c.keyPath,
          hasPassword: false,
          jump: c.jump,
        },
        password: "", // Some("") clears the stored password
      });
      refresh();
    } catch (err) {
      setError(errMessage(err));
    }
  }

  function menuItems(c: SavedConnection): MenuItem[] {
    const items: MenuItem[] = [
      { label: "Connect", onClick: () => connectSaved(c) },
      {
        label: "Connect + browse files",
        onClick: () => connectSaved(c, { openFiles: true }),
      },
    ];
    items.push({
      label: "Open in external terminal",
      onClick: () => {
        invoke("external_terminal", { id: c.id }).catch((err) =>
          setError(errMessage(err)),
        );
      },
    });
    items.push({ label: "Deploy public key…", onClick: () => deployKey(c) });
    if (c.hasPassword) {
      items.push({
        label: "Forget saved password",
        onClick: () => forgetPassword(c),
      });
    }
    items.push(
      { label: "", separator: true },
      {
        label: "Edit…",
        onClick: () => {
          setConfirmDeleteId(null);
          editSaved(c);
        },
      },
      {
        label: "Remove…",
        danger: true,
        // arms the row's red "sure?" button instead of deleting blind
        onClick: () => setConfirmDeleteId(c.id),
      },
    );
    return items;
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
    setJump(c.jump || "");
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
    setJump("");
    setSave(false);
    setRemember(false);
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    doConnect();
  }

  async function doConnect() {
    setConnecting(true);
    setError(null);
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
            jump,
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
        jumpId: jump || null,
      });
      onConnected(id, title, {
        host,
        user,
        port: parseInt(port, 10) || 22,
        name: title,
      });
    } catch (err) {
      const issue = asHostKeyIssue(err);
      if (issue) {
        setHostKeyPrompt({ issue, retry: () => doConnect() });
      } else {
        setError(errMessage(err));
      }
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="connect-screen">
      <div className="connect-layout">
        <div className="connect-side">
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, conn: c });
                }}
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
        </div>
        <S3Storages key={importBump} onOpen={onOpenS3} />
        <KeysCard />
        <VaultCard
          onImported={() => {
            refresh();
            setImportBump((n) => n + 1);
          }}
        />
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
              list="vault-keys"
            />
            <datalist id="vault-keys">
              {vaultKeys.map((k) => (
                <option key={k.path} value={k.path}>
                  {k.name}
                </option>
              ))}
            </datalist>
          </label>
          {saved.filter((c) => c.id !== editingId).length > 0 && (
            <label>
              Jump via
              <select
                value={jump}
                onChange={(e) => setJump(e.currentTarget.value)}
              >
                <option value="">(direct)</option>
                {saved
                  .filter((c) => c.id !== editingId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || `${c.user}@${c.host}`}
                    </option>
                  ))}
              </select>
            </label>
          )}
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

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={menuItems(ctxMenu.conn)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {hostKeyPrompt && (
        <div className="modal-overlay">
          <div
            className={
              "hostkey-dialog" +
              (hostKeyPrompt.issue.kind === "hostKeyChanged" ? " danger" : "")
            }
          >
            {hostKeyPrompt.issue.kind === "hostKeyChanged" ? (
              <>
                <h3>⚠ Host key changed!</h3>
                <p>
                  The identity of{" "}
                  <strong>
                    {hostKeyPrompt.issue.host}:{hostKeyPrompt.issue.port}
                  </strong>{" "}
                  has CHANGED since you last connected. Someone could be
                  intercepting this connection, or the server was reinstalled.
                  Only continue if you know why the key changed.
                </p>
              </>
            ) : (
              <>
                <h3>Unknown host</h3>
                <p>
                  First connection to{" "}
                  <strong>
                    {hostKeyPrompt.issue.host}:{hostKeyPrompt.issue.port}
                  </strong>
                  . Verify the fingerprint before trusting it.
                </p>
              </>
            )}
            <code className="fingerprint">{hostKeyPrompt.issue.fingerprint}</code>
            <div className="dialog-buttons">
              <button type="button" onClick={() => setHostKeyPrompt(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={
                  hostKeyPrompt.issue.kind === "hostKeyChanged"
                    ? "danger-btn"
                    : "accent-btn"
                }
                onClick={trustAndRetry}
              >
                Trust &amp; connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ConnectForm;
