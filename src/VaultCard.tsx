import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

interface Props {
  onImported: () => void;
}

function VaultCard({ onImported }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportBackup() {
    if (!passphrase) {
      setError("Enter a passphrase first.");
      return;
    }
    const path = await saveDialog({
      defaultPath: "remotepal-backup.rpal",
      title: "Export encrypted backup",
    });
    if (typeof path !== "string") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await invoke("vault_export", { path, password: passphrase });
      setNotice("Backup exported. It also restores in RemotePal (Python).");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function importBackup() {
    if (!passphrase) {
      setError("Enter the backup's passphrase first.");
      return;
    }
    const path = await openDialog({
      multiple: false,
      title: "Import backup",
      filters: [{ name: "RemotePal backup", extensions: ["rpal", "*"] }],
    });
    if (typeof path !== "string") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const summary = await invoke<{
        connections: number;
        storages: number;
        snippets: number;
        keys: number;
      }>("vault_import", { path, password: passphrase });
      setNotice(
        `Imported ${summary.connections} connections, ` +
          `${summary.storages} storages, ${summary.snippets} snippets, ` +
          `${summary.keys} keys.`,
      );
      onImported();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="saved-panel">
      <h2>Backup</h2>
      <input
        type="password"
        className="vault-pass"
        value={passphrase}
        onChange={(e) => setPassphrase(e.currentTarget.value)}
        placeholder="backup passphrase"
      />
      <div className="vault-buttons">
        <button type="button" disabled={busy} onClick={exportBackup}>
          Export…
        </button>
        <button type="button" disabled={busy} onClick={importBackup}>
          Import…
        </button>
      </div>
      <div className="saved-empty">
        Encrypted archive of connections, S3 storages, snippets, keys, and
        stored secrets — compatible with the PyQt app's backups.
      </div>
      {notice && <div className="connect-notice">{notice}</div>}
      {error && <div className="connect-error">{error}</div>}
    </div>
  );
}

export default VaultCard;
