import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import ContextMenu, { type MenuItem } from "./ContextMenu";

export interface VaultKey {
  name: string;
  path: string;
  publicKey: string | null;
}

function KeysCard() {
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(
    null,
  );
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    key: VaultKey;
  } | null>(null);

  async function refresh() {
    try {
      setKeys(await invoke<VaultKey[]>("keys_list"));
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function flash(text: string) {
    setNotice(text);
    setError(null);
  }

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setError(null);
    try {
      await invoke("key_generate", { name: newName.trim() });
      flash(`Generated ed25519 key "${newName.trim()}".`);
      setNewName("");
      setGenerating(false);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function importFile() {
    const path = await openDialog({
      multiple: false,
      title: "Import private key into the vault",
    });
    if (typeof path !== "string") return;
    setError(null);
    try {
      const name = await invoke<string>("key_import_file", { path });
      flash(`Imported "${name}".`);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function importOs() {
    setError(null);
    try {
      const names = await invoke<string[]>("keys_import_os");
      flash(
        names.length
          ? `Imported from ~/.ssh: ${names.join(", ")}`
          : "Nothing new found in ~/.ssh.",
      );
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function copyPublic(key: VaultKey) {
    if (!key.publicKey) {
      setError(`${key.name} has no .pub file.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(key.publicKey);
      flash(`Public key of "${key.name}" copied.`);
    } catch {
      setError("clipboard unavailable");
    }
  }

  async function installOs(key: VaultKey) {
    setError(null);
    try {
      await invoke("key_install_os", { name: key.name });
      flash(`Installed "${key.name}" into ~/.ssh.`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove(key: VaultKey) {
    if (confirmDeleteName !== key.name) {
      setConfirmDeleteName(key.name);
      return;
    }
    setConfirmDeleteName(null);
    setError(null);
    try {
      await invoke("key_delete", { name: key.name });
      flash(`Deleted "${key.name}".`);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="saved-panel">
      <h2>Keys</h2>
      {keys.length === 0 && (
        <div className="saved-empty">No key pairs in the vault yet.</div>
      )}
      <ul className="saved-list">
        {keys.map((key) => (
          <li
            key={key.name}
            className="saved-item"
            title="Right-click for actions"
            onClick={() => copyPublic(key)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, key });
            }}
          >
            <div className="saved-text">
              <span className="saved-name">{key.name}</span>
              <span className="saved-detail">
                {key.publicKey
                  ? key.publicKey.split(" ").slice(0, 1) + " · click to copy .pub"
                  : "no .pub file"}
              </span>
            </div>
            <span className="saved-actions">
              <button
                type="button"
                className={
                  "saved-delete" +
                  (confirmDeleteName === key.name ? " confirming" : "")
                }
                title={
                  confirmDeleteName === key.name
                    ? "Click again to delete"
                    : "Delete"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  remove(key);
                }}
              >
                {confirmDeleteName === key.name ? "sure?" : <X size={13} />}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {generating ? (
        <form className="forwards-form" onSubmit={generate}>
          <input
            autoFocus
            className="fw-host"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            placeholder="key name (ed25519)"
            onKeyDown={(e) => {
              if (e.key === "Escape") setGenerating(false);
            }}
          />
          <button type="submit">Generate</button>
        </form>
      ) : (
        <div className="vault-buttons">
          <button type="button" onClick={() => setGenerating(true)}>
            Generate…
          </button>
          <button type="button" onClick={importFile}>
            Import file…
          </button>
          <button type="button" onClick={importOs} title="Scan ~/.ssh">
            From ~/.ssh
          </button>
        </div>
      )}
      {notice && <div className="connect-notice">{notice}</div>}
      {error && <div className="connect-error">{error}</div>}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={
            [
              {
                label: "Copy public key",
                onClick: () => copyPublic(ctxMenu.key),
              },
              {
                label: "Install into ~/.ssh",
                onClick: () => installOs(ctxMenu.key),
              },
              { label: "", separator: true },
              {
                label: "Delete…",
                danger: true,
                onClick: () => setConfirmDeleteName(ctxMenu.key.name),
              },
            ] satisfies MenuItem[]
          }
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

export default KeysCard;
