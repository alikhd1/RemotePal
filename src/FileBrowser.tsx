import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

interface SftpEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

interface TransferState {
  label: string;
  done: number;
  total: number;
}

function parentPath(path: string): string {
  if (path === "/" || !path.includes("/")) return path;
  const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return parent === "" ? "/" : parent;
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function localBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "file";
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMtime(mtime: number): string {
  if (!mtime) return "";
  return new Date(mtime * 1000).toLocaleString(undefined, {
    year: "2-digit",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

let nextTransferId = 1;

interface Props {
  sessionId: number;
}

function FileBrowser({ sessionId }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<"mkdir" | "rename" | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const transferIdRef = useRef<string | null>(null);

  async function load(dir: string) {
    setError(null);
    setSelected(null);
    setConfirmDelete(false);
    setInputMode(null);
    try {
      const list = await invoke<SftpEntry[]>("sftp_list", {
        id: sessionId,
        path: dir,
      });
      list.sort((a, b) =>
        a.isDir !== b.isDir
          ? Number(b.isDir) - Number(a.isDir)
          : a.name.localeCompare(b.name),
      );
      setEntries(list);
      setPath(dir);
      setPathInput(dir);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    invoke<string>("sftp_home", { id: sessionId })
      .then((home) => {
        if (!cancelled) load(home);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    const unlisten: Promise<UnlistenFn> = listen<{
      transferId: string;
      done: number;
      total: number;
    }>("sftp-progress", (e) => {
      if (e.payload.transferId === transferIdRef.current) {
        setTransfer((t) =>
          t ? { ...t, done: e.payload.done, total: e.payload.total } : t,
        );
      }
    });
    return () => {
      cancelled = true;
      unlisten.then((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const selectedEntry = entries.find((e) => e.name === selected) ?? null;

  async function upload() {
    if (!path) return;
    const local = await openDialog({ multiple: false, title: "Upload file" });
    if (typeof local !== "string") return;
    const name = localBasename(local);
    await runTransfer(`↑ ${name}`, (tid) =>
      invoke<number>("sftp_upload", {
        id: sessionId,
        localPath: local,
        remotePath: joinPath(path, name),
        transferId: tid,
      }),
    );
  }

  async function download() {
    if (!path || !selectedEntry || selectedEntry.isDir) return;
    const local = await saveDialog({
      defaultPath: selectedEntry.name,
      title: "Download to",
    });
    if (typeof local !== "string") return;
    await runTransfer(`↓ ${selectedEntry.name}`, (tid) =>
      invoke<number>("sftp_download", {
        id: sessionId,
        remotePath: joinPath(path, selectedEntry.name),
        localPath: local,
        transferId: tid,
      }),
    );
  }

  async function runTransfer(
    label: string,
    fn: (tid: string) => Promise<number>,
  ) {
    const tid = `t${nextTransferId++}`;
    transferIdRef.current = tid;
    setTransfer({ label, done: 0, total: 0 });
    setError(null);
    try {
      await fn(tid);
      if (path) load(path);
    } catch (err) {
      setError(String(err));
    } finally {
      transferIdRef.current = null;
      setTransfer(null);
    }
  }

  async function submitInput(e: React.FormEvent) {
    e.preventDefault();
    if (!path || !inputValue.trim()) return;
    const value = inputValue.trim();
    setError(null);
    try {
      if (inputMode === "mkdir") {
        await invoke("sftp_mkdir", {
          id: sessionId,
          path: joinPath(path, value),
        });
      } else if (inputMode === "rename" && selectedEntry) {
        await invoke("sftp_rename", {
          id: sessionId,
          from: joinPath(path, selectedEntry.name),
          to: joinPath(path, value),
        });
      }
      setInputMode(null);
      setInputValue("");
      load(path);
    } catch (err) {
      setError(String(err));
    }
  }

  async function deleteSelected() {
    if (!path || !selectedEntry) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    setError(null);
    try {
      await invoke("sftp_delete", {
        id: sessionId,
        path: joinPath(path, selectedEntry.name),
        isDir: selectedEntry.isDir,
      });
      load(path);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="files-panel">
      <div className="files-pathbar">
        <button
          type="button"
          title="Up"
          disabled={!path || path === "/"}
          onClick={() => path && load(parentPath(path))}
        >
          ↑
        </button>
        <form
          className="files-pathform"
          onSubmit={(e) => {
            e.preventDefault();
            if (pathInput.trim()) load(pathInput.trim());
          }}
        >
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.currentTarget.value)}
            spellCheck={false}
          />
        </form>
        <button type="button" title="Refresh" onClick={() => path && load(path)}>
          ⟳
        </button>
      </div>

      <div className="files-toolbar">
        <button type="button" onClick={upload} disabled={!path || !!transfer}>
          Upload
        </button>
        <button
          type="button"
          onClick={download}
          disabled={!selectedEntry || selectedEntry.isDir || !!transfer}
        >
          Download
        </button>
        <button
          type="button"
          onClick={() => {
            setInputMode("mkdir");
            setInputValue("");
          }}
          disabled={!path}
        >
          New dir
        </button>
        <button
          type="button"
          onClick={() => {
            if (selectedEntry) {
              setInputMode("rename");
              setInputValue(selectedEntry.name);
            }
          }}
          disabled={!selectedEntry}
        >
          Rename
        </button>
        <button
          type="button"
          className={confirmDelete ? "files-delete confirming" : "files-delete"}
          onClick={deleteSelected}
          disabled={!selectedEntry}
        >
          {confirmDelete ? "sure?" : "Delete"}
        </button>
      </div>

      {inputMode && (
        <form className="files-inputrow" onSubmit={submitInput}>
          <input
            autoFocus
            value={inputValue}
            placeholder={inputMode === "mkdir" ? "new directory name" : "new name"}
            onChange={(e) => setInputValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setInputMode(null);
            }}
            spellCheck={false}
          />
          <button type="submit">OK</button>
        </form>
      )}

      <div className="files-list">
        {entries.map((entry) => (
          <div
            key={entry.name}
            className={
              "files-row" + (selected === entry.name ? " selected" : "")
            }
            onClick={() => {
              setSelected(entry.name);
              setConfirmDelete(false);
            }}
            onDoubleClick={() => {
              if (entry.isDir && path) load(joinPath(path, entry.name));
            }}
          >
            <span className="files-icon">{entry.isDir ? "📁" : "📄"}</span>
            <span className="files-name" title={entry.name}>
              {entry.name}
            </span>
            <span className="files-size">
              {entry.isDir ? "" : humanSize(entry.size)}
            </span>
            <span className="files-mtime">{formatMtime(entry.mtime)}</span>
          </div>
        ))}
        {path && entries.length === 0 && (
          <div className="files-empty">Empty directory</div>
        )}
      </div>

      {transfer && (
        <div className="files-transfer">
          <span className="files-transfer-label">{transfer.label}</span>
          <div className="files-progress">
            <div
              className="files-progress-fill"
              style={{
                width: transfer.total
                  ? `${Math.min(100, (transfer.done / transfer.total) * 100)}%`
                  : "10%",
              }}
            />
          </div>
          <span className="files-transfer-pct">
            {transfer.total
              ? `${Math.floor((transfer.done / transfer.total) * 100)}%`
              : "…"}
          </span>
        </div>
      )}

      {error && <div className="files-error">{error}</div>}
    </div>
  );
}

export default FileBrowser;
