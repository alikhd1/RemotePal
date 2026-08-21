import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

interface S3Object {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

interface S3Listing {
  folders: string[];
  objects: S3Object[];
}

interface Row {
  id: string; // folder prefix or object key — unique across both
  name: string;
  isFolder: boolean;
  size: number;
  lastModified: string;
}

interface TransferState {
  label: string;
  done: number;
  total: number;
}

function localBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "file";
}

function joinLocal(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

let nextTransferId = 1;

interface Props {
  storageId: string;
  active: boolean;
}

function S3Browser({ storageId, active }: Props) {
  const [prefix, setPrefix] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<"rename" | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const transferIdRef = useRef<string | null>(null);
  const prefixRef = useRef("");
  void active;

  async function load(pfx: string) {
    setError(null);
    setSelected(new Set());
    setAnchor(null);
    setConfirmDelete(false);
    setInputMode(null);
    try {
      const listing = await invoke<S3Listing>("s3_list", {
        id: storageId,
        prefix: pfx,
      });
      const folderRows: Row[] = listing.folders.map((f) => ({
        id: f,
        name: f.slice(pfx.length).replace(/\/$/, ""),
        isFolder: true,
        size: 0,
        lastModified: "",
      }));
      const objectRows: Row[] = listing.objects.map((o) => ({
        id: o.key,
        name: o.name,
        isFolder: false,
        size: o.size,
        lastModified: o.lastModified,
      }));
      setRows([...folderRows, ...objectRows]);
      setPrefix(pfx);
      prefixRef.current = pfx;
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    load("");
    const unlisten: Promise<UnlistenFn> = listen<{
      transferId: string;
      done: number;
      total: number;
    }>("s3-progress", (e) => {
      if (e.payload.transferId === transferIdRef.current) {
        setTransfer((t) =>
          t ? { ...t, done: e.payload.done, total: e.payload.total } : t,
        );
      }
    });
    return () => {
      unlisten.then((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageId]);

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const singleRow = selectedRows.length === 1 ? selectedRows[0] : null;

  function handleSelect(ev: React.MouseEvent, row: Row) {
    setConfirmDelete(false);
    if (ev.ctrlKey) {
      const next = new Set(selected);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      setSelected(next);
      setAnchor(row.id);
      return;
    }
    if (ev.shiftKey && anchor) {
      const ids = rows.map((r) => r.id);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(row.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(ids.slice(lo, hi + 1)));
        return;
      }
    }
    setSelected(new Set([row.id]));
    setAnchor(row.id);
  }

  async function runTransfer(
    label: string,
    fn: (tid: string) => Promise<number>,
  ) {
    const tid = `s3t${nextTransferId++}`;
    transferIdRef.current = tid;
    setTransfer({ label, done: 0, total: 0 });
    setError(null);
    try {
      await fn(tid);
      load(prefixRef.current);
    } catch (err) {
      setError(String(err));
    } finally {
      transferIdRef.current = null;
      setTransfer(null);
    }
  }

  async function upload() {
    const local = await openDialog({ multiple: true, title: "Upload files" });
    if (!local) return;
    const files = Array.isArray(local) ? local : [local];
    for (let i = 0; i < files.length; i++) {
      const name = localBasename(files[i]);
      const label =
        files.length > 1 ? `↑ ${name} (${i + 1}/${files.length})` : `↑ ${name}`;
      await runTransfer(label, (tid) =>
        invoke<number>("s3_upload", {
          id: storageId,
          localPath: files[i],
          key: prefixRef.current + name,
          transferId: tid,
        }),
      );
    }
  }

  async function download() {
    const files = selectedRows.filter((r) => !r.isFolder);
    if (files.length === 0) return;
    if (files.length === 1) {
      const local = await saveDialog({
        defaultPath: files[0].name,
        title: "Download to",
      });
      if (typeof local !== "string") return;
      await runTransfer(`↓ ${files[0].name}`, (tid) =>
        invoke<number>("s3_download", {
          id: storageId,
          key: files[0].id,
          localPath: local,
          transferId: tid,
        }),
      );
      return;
    }
    const dir = await openDialog({
      directory: true,
      title: "Download into folder",
    });
    if (typeof dir !== "string") return;
    for (let i = 0; i < files.length; i++) {
      await runTransfer(`↓ ${files[i].name} (${i + 1}/${files.length})`, (tid) =>
        invoke<number>("s3_download", {
          id: storageId,
          key: files[i].id,
          localPath: joinLocal(dir, files[i].name),
          transferId: tid,
        }),
      );
    }
  }

  async function deleteSelected() {
    if (selectedRows.length === 0) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    setError(null);
    try {
      for (const row of selectedRows) {
        await invoke("s3_delete", {
          id: storageId,
          key: row.id,
          isPrefix: row.isFolder,
        });
      }
      load(prefixRef.current);
    } catch (err) {
      setError(String(err));
      load(prefixRef.current);
    }
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!singleRow || singleRow.isFolder || !inputValue.trim()) return;
    try {
      await invoke("s3_rename", {
        id: storageId,
        from: singleRow.id,
        to: prefix + inputValue.trim(),
      });
      setInputMode(null);
      load(prefix);
    } catch (err) {
      setError(String(err));
    }
  }

  function up() {
    const trimmed = prefix.replace(/\/$/, "");
    const idx = trimmed.lastIndexOf("/");
    load(idx >= 0 ? trimmed.slice(0, idx + 1) : "");
  }

  return (
    <div className="files-panel full">
      <div className="files-pathbar">
        <button type="button" title="Up" disabled={!prefix} onClick={up}>
          ↑
        </button>
        <div className="s3-prefix" title={prefix || "/"}>
          {prefix || "/"}
        </div>
        <button type="button" title="Refresh" onClick={() => load(prefix)}>
          ⟳
        </button>
      </div>

      <div className="files-toolbar">
        <button type="button" onClick={upload} disabled={!!transfer}>
          Upload
        </button>
        <button
          type="button"
          onClick={download}
          disabled={!selectedRows.some((r) => !r.isFolder) || !!transfer}
        >
          Download
        </button>
        <button
          type="button"
          onClick={() => {
            if (singleRow && !singleRow.isFolder) {
              setInputMode("rename");
              setInputValue(singleRow.name);
            }
          }}
          disabled={!singleRow || singleRow.isFolder}
        >
          Rename
        </button>
        <button
          type="button"
          className={confirmDelete ? "files-delete confirming" : "files-delete"}
          onClick={deleteSelected}
          disabled={selectedRows.length === 0}
        >
          {confirmDelete
            ? `sure? (${selectedRows.length})`
            : selectedRows.length > 1
              ? `Delete (${selectedRows.length})`
              : "Delete"}
        </button>
      </div>

      {inputMode === "rename" && (
        <form className="files-inputrow" onSubmit={submitRename}>
          <input
            autoFocus
            value={inputValue}
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
        {rows.map((row) => (
          <div
            key={row.id}
            className={"files-row" + (selected.has(row.id) ? " selected" : "")}
            onClick={(ev) => handleSelect(ev, row)}
            onDoubleClick={() => {
              if (row.isFolder) load(row.id);
            }}
          >
            <span className="files-icon">{row.isFolder ? "📁" : "📄"}</span>
            <span className="files-name" title={row.name}>
              {row.name}
            </span>
            <span className="files-size">
              {row.isFolder ? "" : humanSize(row.size)}
            </span>
            <span className="files-mtime">
              {row.lastModified ? row.lastModified.slice(0, 16).replace("T", " ") : ""}
            </span>
          </div>
        ))}
        {rows.length === 0 && !error && (
          <div className="files-empty">Empty</div>
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

export default S3Browser;
