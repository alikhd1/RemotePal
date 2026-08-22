import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FileText, Folder } from "lucide-react";
import ContextMenu, { type MenuItem } from "./ContextMenu";

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
  active: boolean;
}

function FileBrowser({ sessionId, active }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // navigating hits the network; without this the pane just sat still
  const [loading, setLoading] = useState(false);
  const [inputMode, setInputMode] = useState<"mkdir" | "rename" | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const transferIdRef = useRef<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  // the drag-drop subscription is created once; these mirror current state
  const activeRef = useRef(active);
  activeRef.current = active;
  const pathRef = useRef<string | null>(null);

  function flashNotice(text: string) {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }

  async function load(dir: string) {
    setError(null);
    setLoading(true);
    setSelected(new Set());
    setAnchor(null);
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
      pathRef.current = dir;
      setPathInput(dir);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
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
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ transferId: string; done: number; total: number }>(
        "sftp-progress",
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
      listen<{ sessionId: number; name: string }>("sftp-edit-uploaded", (e) => {
        if (e.payload.sessionId === sessionId) {
          flashNotice(`Saved ${e.payload.name} — uploaded`);
        }
      }),
      listen<{ sessionId: number; name: string; message?: string }>(
        "sftp-edit-error",
        (e) => {
          if (e.payload.sessionId === sessionId) {
            setError(`upload of ${e.payload.name} failed: ${e.payload.message}`);
          }
        },
      ),
    ];
    const dragUnlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (!activeRef.current || !pathRef.current) return;
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setDropping(true);
      } else if (event.payload.type === "leave") {
        setDropping(false);
      } else if (event.payload.type === "drop") {
        setDropping(false);
        if (event.payload.paths.length) uploadPaths(event.payload.paths);
      }
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((p) => p.then((un) => un()));
      dragUnlisten.then((un) => un());
      window.clearTimeout(noticeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const selectedEntries = entries.filter((e) => selected.has(e.name));
  const selectedEntry =
    selectedEntries.length === 1 ? selectedEntries[0] : null;

  function handleSelect(ev: React.MouseEvent, entry: SftpEntry) {
    setConfirmDelete(false);
    const name = entry.name;
    if (ev.ctrlKey) {
      const next = new Set(selected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      setSelected(next);
      setAnchor(name);
      return;
    }
    if (ev.shiftKey && anchor) {
      const names = entries.map((e) => e.name);
      const a = names.indexOf(anchor);
      const b = names.indexOf(name);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(names.slice(lo, hi + 1)));
        return;
      }
    }
    setSelected(new Set([name]));
    setAnchor(name);
  }

  async function uploadPaths(locals: string[]) {
    const dir = pathRef.current;
    if (!dir) return;
    for (let i = 0; i < locals.length; i++) {
      const local = locals[i];
      const name = localBasename(local);
      const label =
        locals.length > 1 ? `↑ ${name} (${i + 1}/${locals.length})` : `↑ ${name}`;
      await runTransfer(label, (tid) =>
        invoke<number>("sftp_upload", {
          id: sessionId,
          localPath: local,
          remotePath: joinPath(dir, name),
          transferId: tid,
        }),
      );
    }
  }

  async function upload() {
    if (!path) return;
    const local = await openDialog({ multiple: true, title: "Upload files" });
    if (!local) return;
    await uploadPaths(Array.isArray(local) ? local : [local]);
  }

  async function download() {
    if (!path) return;
    const files = selectedEntries.filter((e) => !e.isDir);
    if (files.length === 0) return;
    if (files.length === 1) {
      const file = files[0];
      const local = await saveDialog({
        defaultPath: file.name,
        title: "Download to",
      });
      if (typeof local !== "string") return;
      await runTransfer(`↓ ${file.name}`, (tid) =>
        invoke<number>("sftp_download", {
          id: sessionId,
          remotePath: joinPath(path, file.name),
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
      const file = files[i];
      await runTransfer(`↓ ${file.name} (${i + 1}/${files.length})`, (tid) =>
        invoke<number>("sftp_download", {
          id: sessionId,
          remotePath: joinPath(path, file.name),
          localPath: joinLocal(dir, file.name),
          transferId: tid,
        }),
      );
    }
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

  async function reallyDelete() {
    if (!path || selectedEntries.length === 0) return;
    setConfirmDelete(false);
    setError(null);
    try {
      for (const entry of selectedEntries) {
        await invoke("sftp_delete", {
          id: sessionId,
          path: joinPath(path, entry.name),
          isDir: entry.isDir,
        });
      }
      load(path);
    } catch (err) {
      setError(String(err));
      load(path);
    }
  }

  /// What double-clicking a row does: descend into a directory, or open
  /// a file in the local editor with saves uploading back.
  async function openEntry(entry: SftpEntry) {
    if (!path) return;
    if (entry.isDir) {
      load(joinPath(path, entry.name));
      return;
    }
    setError(null);
    try {
      await invoke<string>("sftp_edit", {
        id: sessionId,
        remotePath: joinPath(path, entry.name),
      });
      flashNotice(`Editing ${entry.name} — saves auto-upload`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function editSelected() {
    if (!selectedEntry || selectedEntry.isDir) return;
    await openEntry(selectedEntry);
  }

  async function syncFolder(deleteExtra: boolean) {
    if (!path || transfer) return;
    const dir = await openDialog({
      directory: true,
      title: deleteExtra
        ? "Mirror local folder here (deletes remote extras)"
        : "Sync local folder into current remote directory",
    });
    if (typeof dir !== "string") return;
    const tid = `sync${Date.now()}`;
    transferIdRef.current = tid;
    setTransfer({ label: "⇅ comparing…", done: 0, total: 0 });
    setError(null);
    try {
      const summary = await invoke<{
        uploaded: number;
        deleted: number;
        skipped: number;
      }>("sftp_sync", {
        id: sessionId,
        localDir: dir,
        remoteDir: path,
        deleteExtra,
        transferId: tid,
      });
      flashNotice(
        `Sync done: ${summary.uploaded} uploaded, ` +
          `${summary.skipped} unchanged` +
          (deleteExtra ? `, ${summary.deleted} deleted` : ""),
      );
      load(path);
    } catch (err) {
      setError(String(err));
    } finally {
      transferIdRef.current = null;
      setTransfer(null);
    }
  }

  function menuItems(): MenuItem[] {
    const items: MenuItem[] = [];
    const files = selectedEntries.filter((e) => !e.isDir);
    if (selectedEntries.length > 0) {
      if (files.length > 0 && !transfer) {
        items.push({
          label: files.length > 1 ? `Download (${files.length})…` : "Download…",
          onClick: download,
        });
      }
      if (selectedEntry && !selectedEntry.isDir && !transfer) {
        items.push({ label: "Edit (auto-upload on save)", onClick: editSelected });
      }
      if (selectedEntry) {
        items.push({
          label: "Rename…",
          onClick: () => {
            setInputMode("rename");
            setInputValue(selectedEntry.name);
          },
        });
      }
      items.push(
        {
          label:
            selectedEntries.length > 1
              ? `Delete (${selectedEntries.length})…`
              : "Delete…",
          danger: true,
          onClick: () => setConfirmDelete(true),
        },
        { label: "", separator: true },
      );
    }
    items.push(
      { label: "Upload files…", onClick: upload },
      {
        label: "New directory…",
        onClick: () => {
          setInputMode("mkdir");
          setInputValue("");
        },
      },
      { label: "", separator: true },
      { label: "Sync local folder here…", onClick: () => syncFolder(false) },
      {
        label: "Mirror local folder here…",
        danger: true,
        onClick: () => syncFolder(true),
      },
      { label: "", separator: true },
      { label: "Refresh", onClick: () => path && load(path) },
    );
    return items;
  }

  return (
    <div className={"files-panel" + (dropping ? " dropping" : "")}>
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

      {confirmDelete && (
        <div className="files-inputrow">
          <span className="files-confirm-text">
            Delete {selectedEntries.length}{" "}
            {selectedEntries.length === 1 ? "item" : "items"}?
          </span>
          <button type="button" className="danger" onClick={reallyDelete}>
            Delete
          </button>
          <button type="button" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      )}

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

      {loading && <div className="files-loading" />}

      <div
        className="files-list"
        onContextMenu={(ev) => {
          ev.preventDefault();
          // empty-area menu: keep whatever is selected
          setCtxMenu({ x: ev.clientX, y: ev.clientY });
        }}
      >
        {entries.map((entry) => (
          <div
            key={entry.name}
            className={
              "files-row" + (selected.has(entry.name) ? " selected" : "")
            }
            onClick={(ev) => handleSelect(ev, entry)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              if (!selected.has(entry.name)) {
                setSelected(new Set([entry.name]));
                setAnchor(entry.name);
              }
              setConfirmDelete(false);
              setCtxMenu({ x: ev.clientX, y: ev.clientY });
            }}
            onDoubleClick={() => openEntry(entry)}
          >
            <span className="files-icon">
              {entry.isDir ? (
                <Folder size={14} className="icon-folder" />
              ) : (
                <FileText size={14} className="icon-file" />
              )}
            </span>
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

export default FileBrowser;
