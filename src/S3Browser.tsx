import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { FileText, Folder } from "lucide-react";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import {
  clipForBucket,
  clipLabel,
  clearClip,
  setClip,
} from "./fileClipboard";

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
  // bucket being browsed; null = bucket list (unpinned storages only)
  const [bucket, setBucket] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // navigating hits the network; without this the pane just sat still
  const [loading, setLoading] = useState(false);
  const [inputMode, setInputMode] = useState<
    "rename" | "mkbucket" | "targz" | null
  >(
    null,
  );
  const [inputValue, setInputValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const transferIdRef = useRef<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  function flashNotice(text: string) {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }
  const prefixRef = useRef("");
  const bucketRef = useRef<string | null>(null);
  void active;

  function resetView() {
    setError(null);
    setSelected(new Set());
    setAnchor(null);
    setConfirmDelete(false);
    setInputMode(null);
  }

  async function load(pfx: string) {
    resetView();
    setLoading(true);
    try {
      const listing = await invoke<S3Listing>("s3_list", {
        id: storageId,
        bucket: bucketRef.current,
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
    } finally {
      setLoading(false);
    }
  }

  async function loadBuckets() {
    resetView();
    setLoading(true);
    bucketRef.current = null;
    setBucket(null);
    setPrefix("");
    prefixRef.current = "";
    try {
      const names = await invoke<string[]>("s3_list_buckets", {
        id: storageId,
      });
      setRows(
        names.map((name) => ({
          id: `bucket:${name}`,
          name,
          isFolder: true,
          size: 0,
          lastModified: "",
        })),
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function enterBucket(name: string) {
    bucketRef.current = name;
    setBucket(name);
    load("");
  }

  useEffect(() => {
    invoke<{ id: string; bucket: string }[]>("s3_list_storages")
      .then((list) => {
        const storage = list.find((s) => s.id === storageId);
        if (storage?.bucket) {
          setPinned(true);
          enterBucket(storage.bucket);
        } else {
          setPinned(false);
          loadBuckets();
        }
      })
      .catch((err) => setError(String(err)));
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ transferId: string; done: number; total: number }>(
        "s3-progress",
        (e) => {
          if (e.payload.transferId === transferIdRef.current) {
            setTransfer((t) =>
              t ? { ...t, done: e.payload.done, total: e.payload.total } : t,
            );
          }
        },
      ),
      listen<{
        transferId: string;
        current: string;
        index: number;
        total: number;
      }>("sync-progress", (e) => {
        if (e.payload.transferId === transferIdRef.current) {
          setTransfer((t) =>
            t
              ? {
                  ...t,
                  label: `⇅ ${e.payload.current}`,
                  done: e.payload.index,
                  total: e.payload.total,
                }
              : t,
          );
        }
      }),
      listen<{ storageId: string; name: string }>("s3-edit-uploaded", (e) => {
        if (e.payload.storageId === storageId) {
          flashNotice(`Saved ${e.payload.name} — uploaded`);
        }
      }),
      listen<{ storageId: string; name: string; message?: string }>(
        "s3-edit-error",
        (e) => {
          if (e.payload.storageId === storageId) {
            setError(`upload of ${e.payload.name} failed: ${e.payload.message}`);
          }
        },
      ),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
      window.clearTimeout(noticeTimer.current);
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
          bucket: bucketRef.current,
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
          bucket: bucketRef.current,
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
          bucket: bucketRef.current,
          key: files[i].id,
          localPath: joinLocal(dir, files[i].name),
          transferId: tid,
        }),
      );
    }
  }

  async function reallyDelete() {
    if (selectedRows.length === 0) return;
    setConfirmDelete(false);
    setError(null);
    try {
      for (const row of selectedRows) {
        await invoke("s3_delete", {
          id: storageId,
          bucket: bucketRef.current,
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

  async function copyLink(row: Row) {
    try {
      const url = await invoke<string>("s3_presign", {
        id: storageId,
        bucket: bucketRef.current,
        key: row.id,
        expirySecs: 3600,
      });
      await navigator.clipboard.writeText(url);
      flashNotice(`Download link for ${row.name} copied (valid 1 h).`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function editObject(row: Row) {
    setError(null);
    try {
      await invoke<string>("s3_edit", {
        id: storageId,
        bucket: bucketRef.current,
        key: row.id,
      });
      flashNotice(`Editing ${row.name} — saves auto-upload`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function syncFolder(deleteExtra: boolean) {
    if (transfer) return;
    const dir = await openDialog({
      directory: true,
      title: deleteExtra
        ? "Mirror local folder here (deletes remote extras)"
        : "Sync local folder into current prefix",
    });
    if (typeof dir !== "string") return;
    const tid = `s3sync${Date.now()}`;
    transferIdRef.current = tid;
    setTransfer({ label: "⇅ comparing…", done: 0, total: 0 });
    setError(null);
    try {
      const summary = await invoke<{
        uploaded: number;
        deleted: number;
        skipped: number;
      }>("s3_sync", {
        id: storageId,
        bucket: bucketRef.current,
        localDir: dir,
        prefix: prefixRef.current,
        deleteExtra,
        transferId: tid,
      });
      flashNotice(
        `Sync done: ${summary.uploaded} uploaded, ` +
          `${summary.skipped} unchanged` +
          (deleteExtra ? `, ${summary.deleted} deleted` : ""),
      );
      load(prefixRef.current);
    } catch (err) {
      setError(String(err));
    } finally {
      transferIdRef.current = null;
      setTransfer(null);
    }
  }

  function copySelection(mode: "copy" | "cut") {
    if (bucket === null || selectedRows.length === 0) return;
    setClip({
      kind: "s3",
      storageId,
      bucket,
      items: selectedRows.map((r) => r.id),
      mode,
    });
    flashNotice(
      `${mode === "cut" ? "Cut" : "Copied"} ${selectedRows.length} item${selectedRows.length === 1 ? "" : "s"}`,
    );
  }

  async function paste() {
    const clip = clipForBucket(storageId, bucket);
    if (!clip) return;
    setError(null);
    setLoading(true);
    try {
      const n = await invoke<number>("s3_copy", {
        id: storageId,
        bucket: bucketRef.current,
        sources: clip.items,
        destPrefix: prefixRef.current,
        moveItems: clip.mode === "cut",
      });
      if (clip.mode === "cut") clearClip();
      flashNotice(
        `${clip.mode === "cut" ? "Moved" : "Copied"} ${n} object${n === 1 ? "" : "s"}`,
      );
      await load(prefixRef.current);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function menuItems(): MenuItem[] {
    const items: MenuItem[] = [];
    if (bucket === null) {
      if (singleRow) {
        items.push({
          label: `Open ${singleRow.name}`,
          onClick: () => enterBucket(singleRow.name),
        });
      }
      items.push(
        {
          label: "New bucket…",
          onClick: () => {
            setInputMode("mkbucket");
            setInputValue("");
          },
        },
        { label: "", separator: true },
        { label: "Refresh", onClick: loadBuckets },
      );
      return items;
    }
    const files = selectedRows.filter((r) => !r.isFolder);
    if (selectedRows.length > 0) {
      if (singleRow?.isFolder) {
        items.push({ label: "Open", onClick: () => load(singleRow.id) });
      }
      if (files.length > 0 && !transfer) {
        items.push({
          label: files.length > 1 ? `Download (${files.length})…` : "Download…",
          onClick: download,
        });
      }
      if (singleRow && !singleRow.isFolder) {
        items.push(
          {
            label: "Edit (auto-upload on save)",
            onClick: () => editObject(singleRow),
          },
          {
            label: "Copy download link (1 h)",
            onClick: () => copyLink(singleRow),
          },
          {
            label: "Rename…",
            onClick: () => {
              setInputMode("rename");
              setInputValue(singleRow.name);
            },
          },
        );
      }
      items.push(
        { label: "", separator: true },
        { label: "Copy", onClick: () => copySelection("copy") },
        { label: "Cut", onClick: () => copySelection("cut") },
        {
          // no server-side packing in S3: this pulls the objects down and
          // pushes the archive back, so it is worth saying so
          label: "Compress to .tar.gz (downloads + re-uploads)…",
          onClick: () => {
            setInputMode("targz");
            setInputValue(
              selectedRows.length === 1
                ? selectedRows[0].name.replace(/\.[^.]+$/, "")
                : "archive",
            );
          },
        },
        { label: "", separator: true },
        {
          label:
            selectedRows.length > 1
              ? `Delete (${selectedRows.length})…`
              : selectedRows[0].isFolder
                ? "Delete recursively…"
                : "Delete…",
          danger: true,
          onClick: () => setConfirmDelete(true),
        },
        { label: "", separator: true },
      );
    }
    const clip = clipForBucket(storageId, bucket);
    if (clip) {
      items.push(
        {
          label: `Paste ${clipLabel(clip)}${clip.mode === "cut" ? " (move)" : ""}`,
          onClick: paste,
        },
        { label: "", separator: true },
      );
    }
    items.push(
      { label: "Upload files…", onClick: upload },
      { label: "", separator: true },
      { label: "Sync local folder here…", onClick: () => syncFolder(false) },
      {
        label: "Mirror local folder here…",
        danger: true,
        onClick: () => syncFolder(true),
      },
      { label: "", separator: true },
      { label: "Refresh", onClick: () => load(prefixRef.current) },
    );
    return items;
  }

  async function submitInput(e: React.FormEvent) {
    e.preventDefault();
    if (!inputValue.trim()) return;
    if (inputMode === "mkbucket") {
      try {
        await invoke("s3_create_bucket", {
          id: storageId,
          name: inputValue.trim(),
        });
        setInputMode(null);
        loadBuckets();
      } catch (err) {
        setError(String(err));
      }
      return;
    }
    if (inputMode === "targz") {
      setLoading(true);
      try {
        const key = await invoke<string>("s3_archive", {
          id: storageId,
          bucket: bucketRef.current,
          sources: selectedRows.map((r) => r.id),
          destPrefix: prefixRef.current,
          archive: inputValue.trim(),
        });
        setInputMode(null);
        setInputValue("");
        flashNotice(`Created ${key}`);
        await load(prefixRef.current);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!singleRow || singleRow.isFolder) return;
    try {
      await invoke("s3_rename", {
        id: storageId,
        bucket: bucketRef.current,
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
    if (prefix === "" && !pinned && bucket !== null) {
      loadBuckets();
      return;
    }
    const trimmed = prefix.replace(/\/$/, "");
    const idx = trimmed.lastIndexOf("/");
    load(idx >= 0 ? trimmed.slice(0, idx + 1) : "");
  }

  return (
    <div className="files-panel full">
      <div className="files-pathbar">
        <button
          type="button"
          title="Up"
          disabled={!prefix && (pinned || bucket === null)}
          onClick={up}
        >
          ↑
        </button>
        <div
          className="s3-prefix"
          title={bucket === null ? "buckets" : `${bucket}/${prefix}`}
        >
          {bucket === null ? "(buckets)" : `${bucket}/${prefix}`}
        </div>
        <button
          type="button"
          title="Refresh"
          onClick={() => (bucket === null ? loadBuckets() : load(prefix))}
        >
          ⟳
        </button>
      </div>

      {confirmDelete && (
        <div className="files-inputrow">
          <span className="files-confirm-text">
            Delete {selectedRows.length}{" "}
            {selectedRows.length === 1 ? "item" : "items"}
            {selectedRows.some((r) => r.isFolder)
              ? " (folders delete recursively)"
              : ""}
            ?
          </span>
          <button type="button" className="danger" onClick={reallyDelete}>
            Delete
          </button>
          <button type="button" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      )}

      {inputMode !== null && (
        <form className="files-inputrow" onSubmit={submitInput}>
          <input
            autoFocus
            value={inputValue}
            placeholder={
              inputMode === "mkbucket"
                ? "new bucket name"
                : inputMode === "targz"
                  ? "archive name (.tar.gz added)"
                  : "new name"
            }
            onChange={(e) => setInputValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setInputMode(null);
            }}
            spellCheck={false}
          />
          <button type="submit">OK</button>
        </form>
      )}

      {loading && <div className="files-loading" />}

      <div
        className="files-list"
        onContextMenu={(ev) => {
          ev.preventDefault();
          setCtxMenu({ x: ev.clientX, y: ev.clientY });
        }}
      >
        {rows.map((row) => (
          <div
            key={row.id}
            className={"files-row" + (selected.has(row.id) ? " selected" : "")}
            onMouseDown={(ev) => {
              // shift-click would otherwise drag a text selection across rows
              if (ev.shiftKey) ev.preventDefault();
            }}
            onClick={(ev) => handleSelect(ev, row)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              if (!selected.has(row.id)) {
                setSelected(new Set([row.id]));
                setAnchor(row.id);
              }
              setConfirmDelete(false);
              setCtxMenu({ x: ev.clientX, y: ev.clientY });
            }}
            onDoubleClick={() => {
              if (bucket === null) enterBucket(row.name);
              else if (row.isFolder) load(row.id);
              else editObject(row);
            }}
          >
            <span className="files-icon">
              {row.isFolder ? (
                <Folder size={14} className="icon-folder" />
              ) : (
                <FileText size={14} className="icon-file" />
              )}
            </span>
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

      {notice && <div className="files-notice">{notice}</div>}
      {error && <div className="files-error">{error}</div>}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={menuItems()}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

export default S3Browser;
