import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu, { type MenuItem } from "./ContextMenu";

export interface S3Storage {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  pathStyle: boolean;
}

interface Props {
  onOpen: (storageId: string, title: string) => void;
}

function S3Storages({ onOpen }: Props) {
  const [storages, setStorages] = useState<S3Storage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    storage: S3Storage;
  } | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [pathStyle, setPathStyle] = useState(false);

  async function refresh() {
    try {
      setStorages(await invoke<S3Storage[]>("s3_list_storages"));
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function clearForm() {
    setEditingId(null);
    setName("");
    setEndpoint("");
    setRegion("");
    setBucket("");
    setAccessKey("");
    setSecretKey("");
    setPathStyle(false);
  }

  function edit(s: S3Storage) {
    setEditingId(s.id);
    setName(s.name);
    setEndpoint(s.endpoint);
    setRegion(s.region);
    setBucket(s.bucket);
    setAccessKey(s.accessKey);
    setSecretKey("");
    setPathStyle(s.pathStyle);
    setShowForm(true);
  }

  async function remove(s: S3Storage) {
    if (confirmDeleteId !== s.id) {
      setConfirmDeleteId(s.id);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await invoke("s3_delete_storage", { id: s.id });
      if (editingId === s.id) {
        clearForm();
        setShowForm(false);
      }
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await invoke<S3Storage>("s3_save_storage", {
        storage: {
          id: editingId ?? "",
          name: name || bucket,
          endpoint,
          region,
          bucket,
          accessKey,
          pathStyle,
        },
        secret: secretKey || null,
      });
      clearForm();
      setShowForm(false);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="saved-panel">
      <h2>S3 storages</h2>
      {storages.length === 0 && !showForm && (
        <div className="saved-empty">No storages yet.</div>
      )}
      <ul className="saved-list">
        {storages.map((s) => (
          <li
            key={s.id}
            className="saved-item"
            onClick={() => onOpen(s.id, s.name || s.bucket)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, storage: s });
            }}
          >
            <div className="saved-text">
              <span className="saved-name">{s.name || s.bucket}</span>
              <span className="saved-detail">
                {s.bucket}
                {s.endpoint ? ` · ${s.endpoint}` : " · AWS"}
              </span>
            </div>
            <span className="saved-actions">
              <button
                type="button"
                title="Edit"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDeleteId(null);
                  edit(s);
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className={
                  "saved-delete" +
                  (confirmDeleteId === s.id ? " confirming" : "")
                }
                title={confirmDeleteId === s.id ? "Click again to delete" : "Delete"}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(s);
                }}
              >
                {confirmDeleteId === s.id ? "sure?" : "×"}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {showForm ? (
        <form className="s3-form" onSubmit={save}>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="My storage"
            />
          </label>
          <label>
            Endpoint
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.currentTarget.value)}
              placeholder="https://… (empty for AWS)"
            />
          </label>
          <div className="field-row">
            <label className="grow">
              Bucket
              <input
                value={bucket}
                onChange={(e) => setBucket(e.currentTarget.value)}
                placeholder="(empty = browse all)"
              />
            </label>
            <label className="grow">
              Region
              <input
                value={region}
                onChange={(e) => setRegion(e.currentTarget.value)}
                placeholder="us-east-1"
              />
            </label>
          </div>
          <label>
            Access key
            <input
              value={accessKey}
              onChange={(e) => setAccessKey(e.currentTarget.value)}
              required
            />
          </label>
          <label>
            Secret key
            <input
              type="password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.currentTarget.value)}
              placeholder={editingId ? "(unchanged)" : ""}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={pathStyle}
              onChange={(e) => setPathStyle(e.currentTarget.checked)}
            />
            Path-style addressing (MinIO, moto…)
          </label>
          <div className="dialog-buttons">
            <button
              type="button"
              onClick={() => {
                clearForm();
                setShowForm(false);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="accent-btn">
              Save
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            clearForm();
            setShowForm(true);
          }}
        >
          Add storage…
        </button>
      )}
      {error && <div className="connect-error">{error}</div>}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={
            [
              {
                label: "Open browser",
                onClick: () =>
                  onOpen(ctxMenu.storage.id, ctxMenu.storage.name || ctxMenu.storage.bucket),
              },
              { label: "", separator: true },
              {
                label: "Edit…",
                onClick: () => {
                  setConfirmDeleteId(null);
                  edit(ctxMenu.storage);
                },
              },
              {
                label: "Remove…",
                danger: true,
                onClick: () => setConfirmDeleteId(ctxMenu.storage.id),
              },
            ] satisfies MenuItem[]
          }
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

export default S3Storages;
