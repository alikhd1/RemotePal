import { Fragment, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArchiveRestore,
  ChevronRight,
  Cloud,
  CornerDownLeft,
  FolderClosed,
  KeyRound,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Search,
  Server,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import S3Storages from "./S3Storages";
import VaultCard from "./VaultCard";
import KeysCard, { type VaultKey } from "./KeysCard";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import OsIcon, { OS_CHOICES } from "./osIcons";
import type { SessionMeta } from "./SnippetsPanel";

export interface SavedForward {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  hasPassword: boolean;
  jump: string;
  group: string;
  agentForward: boolean;
  /** OS slug for the icon (see osIcons.tsx); "" until detected */
  os: string;
  /** pinned auto-start forwards — passed through on save so edits keep them */
  forwards: SavedForward[];
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

/** "user@host", "user@host:2222", "ssh -p 2222 user@host" → parts */
export function parseQuickConnect(
  input: string,
): { user: string; host: string; port: string } | null {
  let t = input.trim();
  if (!t) return null;
  if (t.startsWith("ssh ")) t = t.slice(4).trim();
  let port = "22";
  const pFlag = t.match(/(?:^|\s)-p\s*(\d+)(?:\s|$)/);
  if (pFlag) {
    port = pFlag[1];
    t = t.replace(pFlag[0], " ").trim();
  }
  const m = t.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9.:_-]+)$/);
  if (!m) return null;
  let host = m[2];
  const colon = host.lastIndexOf(":");
  if (colon > -1 && /^\d+$/.test(host.slice(colon + 1))) {
    port = host.slice(colon + 1);
    host = host.slice(0, colon);
  }
  if (!host) return null;
  return { user: m[1], host, port };
}

type Section = "hosts" | "keys" | "s3" | "backup";
type ViewMode = "grid" | "list";

const VIEW_KEY = "remotepal-hosts-view";

interface Props {
  onConnected: (
    id: number,
    title: string,
    meta: SessionMeta,
    opts?: { openFiles?: boolean; savedId?: string },
  ) => void;
  onOpenS3: (storageId: string, title: string) => void;
  activeSavedIds: Set<string>;
}

function ConnectForm({ onConnected, onOpenS3, activeSavedIds }: Props) {
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

  const [section, setSection] = useState<Section>("hosts");
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"),
  );
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [jump, setJump] = useState("");
  const [group, setGroup] = useState("");
  const [agentForward, setAgentForward] = useState(false);
  const [os, setOs] = useState("");
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

  function setViewMode(mode: ViewMode) {
    setView(mode);
    localStorage.setItem(VIEW_KEY, mode);
  }

  /** After a connect, learn the host's OS once and remember it. */
  function detectOsInBackground(c: SavedConnection, sessionId: number) {
    if (c.os) return;
    invoke<string>("ssh_detect_os", { id: sessionId })
      .then(async (slug) => {
        if (!slug) return;
        await invoke("connection_save", {
          conn: { ...c, os: slug },
          password: null,
        });
        refresh();
      })
      .catch(() => {});
  }

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
          os: c.os || undefined,
        },
        { ...opts, savedId: c.id },
      );
      detectOsInBackground(c, id);
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
        conn: { ...c, hasPassword: false },
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
        // arms the card's red "sure?" button instead of deleting blind
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
    setGroup(c.group || "");
    setAgentForward(c.agentForward || false);
    setOs(c.os || "");
    setPassword("");
    setSave(true);
    setRemember(false);
    setFormOpen(true);
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
    setGroup("");
    setAgentForward(false);
    setOs("");
    setSave(false);
    setRemember(false);
  }

  function openNewHost(prefill?: { user: string; host: string; port: string }) {
    clearForm();
    if (prefill) {
      setUser(prefill.user);
      setHost(prefill.host);
      setPort(prefill.port);
    }
    if (activeGroup) {
      setGroup(activeGroup);
    }
    setError(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    clearForm();
  }

  /** The full record for connection_save; keeps forwards intact on edit. */
  function connPayload(): SavedConnection {
    const existing = saved.find((c) => c.id === editingId);
    return {
      id: editingId ?? "",
      name: name || `${user}@${host}`,
      host,
      port: parseInt(port, 10) || 22,
      user,
      keyPath,
      hasPassword: false,
      jump,
      group,
      agentForward,
      os,
      forwards: existing?.forwards ?? [],
    };
  }

  async function saveOnly() {
    setError(null);
    try {
      await invoke<SavedConnection>("connection_save", {
        conn: connPayload(),
        // Some(pw) stores, Some("") clears, null leaves untouched
        password: remember ? password : null,
      });
      refresh();
      closeForm();
    } catch (err) {
      setError(errMessage(err));
    }
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
      let savedRecord: SavedConnection | null = null;
      if (save) {
        savedRecord = await invoke<SavedConnection>("connection_save", {
          conn: connPayload(),
          // Some(pw) stores, Some("") clears, null leaves untouched
          password: remember ? password : null,
        });
        setEditingId(savedRecord.id);
        refresh();
      }
      const id = await invoke<number>("ssh_connect", {
        host,
        port: parseInt(port, 10) || 22,
        user,
        password: password || null,
        keyPath: keyPath || null,
        jumpId: jump || null,
        agentForward,
      });
      onConnected(
        id,
        title,
        {
          host,
          user,
          port: parseInt(port, 10) || 22,
          name: title,
          os: os || undefined,
        },
        savedRecord ? { savedId: savedRecord.id } : undefined,
      );
      if (savedRecord) detectOsInBackground(savedRecord, id);
      setFormOpen(false);
      clearForm();
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

  // ---------------------------------------------------------- hosts data

  const sorted = useMemo(
    () =>
      [...saved].sort(
        (a, b) =>
          (a.group || "").localeCompare(b.group || "") ||
          (a.name || "").localeCompare(b.name || ""),
      ),
    [saved],
  );

  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of saved) {
      if (c.group) counts.set(c.group, (counts.get(c.group) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [saved]);

  const trimmedQuery = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (trimmedQuery) {
      return sorted.filter((c) =>
        [c.name, c.host, c.user, c.group, `${c.user}@${c.host}`]
          .join("\u0000")
          .toLowerCase()
          .includes(trimmedQuery),
      );
    }
    if (activeGroup) return sorted.filter((c) => c.group === activeGroup);
    return sorted.filter((c) => !c.group);
  }, [sorted, trimmedQuery, activeGroup]);

  const liveCount = visible.filter((c) => activeSavedIds.has(c.id)).length;
  const quick = parseQuickConnect(query);
  const showGroups = !trimmedQuery && !activeGroup && groups.length > 0;

  function onSearchEnter() {
    if (quick) {
      openNewHost(quick);
      setQuery("");
    } else if (visible.length === 1) {
      connectSaved(visible[0]);
    }
  }

  // ------------------------------------------------------------- render

  function hostEntry(c: SavedConnection, listRow: boolean) {
    const busy = busyId === c.id;
    const Tag = listRow ? "li" : "div";
    return (
      <Tag
        key={c.id}
        className={
          (listRow ? "host-row" : "host-card") + (busy ? " busy" : "")
        }
        onClick={() => connectSaved(c)}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY, conn: c });
        }}
      >
        <OsIcon
          os={c.os}
          size={listRow ? 30 : 38}
          live={activeSavedIds.has(c.id)}
        />
        <div className="host-text">
          <span className="host-name">
            {busy ? "Connecting…" : c.name || `${c.user}@${c.host}`}
          </span>
          <span className="host-detail">
            {c.user}@{c.host}:{c.port}
            {c.hasPassword ? " · password" : c.keyPath ? " · key" : ""}
          </span>
        </div>
        <span className="host-actions">
          <button
            type="button"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmDeleteId(null);
              editSaved(c);
            }}
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            className={
              "host-delete" + (confirmDeleteId === c.id ? " confirming" : "")
            }
            title={confirmDeleteId === c.id ? "Click again to delete" : "Delete"}
            onClick={(e) => {
              e.stopPropagation();
              deleteSaved(c);
            }}
          >
            {confirmDeleteId === c.id ? "sure?" : <Trash2 size={13} />}
          </button>
        </span>
      </Tag>
    );
  }

  function renderHosts() {
    return (
      <>
        <div className="hosts-topbar">
          <div className="hosts-search">
            <Search size={15} />
            <input
              value={query}
              autoFocus
              placeholder="Find a host, or type user@host to connect…"
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSearchEnter();
                if (e.key === "Escape") setQuery("");
              }}
            />
            {quick && (
              <span className="quick-hint">
                <CornerDownLeft size={12} /> {quick.user}@{quick.host}:
                {quick.port}
              </span>
            )}
          </div>
          <div className="view-toggle" role="group" aria-label="View">
            <button
              type="button"
              title="Grid view"
              className={view === "grid" ? "active" : ""}
              onClick={() => setViewMode("grid")}
            >
              <LayoutGrid size={15} />
            </button>
            <button
              type="button"
              title="List view"
              className={view === "list" ? "active" : ""}
              onClick={() => setViewMode("list")}
            >
              <List size={15} />
            </button>
          </div>
          <button
            type="button"
            className="primary-btn"
            onClick={() => openNewHost()}
          >
            <Plus size={15} /> New Host
          </button>
        </div>

        {error && !formOpen && <div className="connect-error">{error}</div>}
        {notice && <div className="connect-notice">{notice}</div>}

        <div className="hosts-scroll">
          {activeGroup && !trimmedQuery && (
            <div className="crumbs">
              <button type="button" onClick={() => setActiveGroup(null)}>
                All hosts
              </button>
              <ChevronRight size={13} />
              <span>{activeGroup}</span>
            </div>
          )}

          {showGroups && (
            <>
              <div className="section-head">
                <h3>Groups</h3>
                <span className="count-badge">{groups.length} total</span>
              </div>
              <div className="group-grid">
                {groups.map((g) => (
                  <button
                    type="button"
                    key={g.name}
                    className="group-card"
                    onClick={() => setActiveGroup(g.name)}
                  >
                    <span className="group-icon">
                      <FolderClosed size={19} />
                    </span>
                    <span className="group-text">
                      <span className="group-name">{g.name}</span>
                      <span className="group-sub">
                        {g.count} host{g.count === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="section-head">
            <h3>Hosts</h3>
            <span className="count-badge">
              {visible.length} {visible.length === 1 ? "entry" : "entries"}
            </span>
            {liveCount > 0 && (
              <span className="live-badge">{liveCount} live</span>
            )}
          </div>

          {saved.length === 0 ? (
            <div className="hosts-empty">
              <Server size={34} />
              <p>No hosts yet.</p>
              <button
                type="button"
                className="primary-btn"
                onClick={() => openNewHost()}
              >
                <Plus size={15} /> Add your first host
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="hosts-empty dim">
              {trimmedQuery
                ? "No hosts match the search."
                : "No ungrouped hosts — pick a group above."}
            </div>
          ) : view === "grid" ? (
            <div className="host-grid">
              {visible.map((c) => hostEntry(c, false))}
            </div>
          ) : (
            <ul className="host-list">
              {visible.map((c, i, arr) => (
                <Fragment key={c.id}>
                  {trimmedQuery &&
                    c.group &&
                    (i === 0 || arr[i - 1].group !== c.group) && (
                      <li className="host-list-group">{c.group}</li>
                    )}
                  {hostEntry(c, true)}
                </Fragment>
              ))}
            </ul>
          )}
        </div>
      </>
    );
  }

  const NAV: { key: Section; label: string; icon: React.ReactNode }[] = [
    { key: "hosts", label: "Hosts", icon: <Server size={17} /> },
    { key: "keys", label: "SSH Keys", icon: <KeyRound size={17} /> },
    { key: "s3", label: "S3 Storage", icon: <Cloud size={17} /> },
    { key: "backup", label: "Backup", icon: <ArchiveRestore size={17} /> },
  ];

  return (
    <div className="home">
      <aside className="side-nav">
        <div className="side-brand">
          <span className="side-logo">
            <SquareTerminal size={20} />
          </span>
          <span className="side-title">RemotePal</span>
        </div>
        {NAV.map((item) => (
          <button
            type="button"
            key={item.key}
            className={"nav-item" + (section === item.key ? " active" : "")}
            onClick={() => setSection(item.key)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </aside>

      <main className="home-main">
        {section === "hosts" && renderHosts()}
        {section === "keys" && (
          <div className="home-cards">
            <KeysCard />
          </div>
        )}
        {section === "s3" && (
          <div className="home-cards">
            <S3Storages key={importBump} onOpen={onOpenS3} />
          </div>
        )}
        {section === "backup" && (
          <div className="home-cards">
            <VaultCard
              onImported={() => {
                refresh();
                setImportBump((n) => n + 1);
              }}
            />
          </div>
        )}
      </main>

      {formOpen && (
        <div className="modal-overlay">
          <form className="host-modal" onSubmit={connect}>
            <div className="host-modal-head">
              <OsIcon os={os} size={30} />
              <h3>{editingId ? `Edit “${name || host}”` : "New host"}</h3>
              <button
                type="button"
                className="icon-btn"
                title="Close"
                onClick={closeForm}
              >
                <X size={16} />
              </button>
            </div>
            <div className="host-modal-body">
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
              <div className="field-row">
                {saved.filter((c) => c.id !== editingId).length > 0 && (
                  <label className="grow">
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
                <label className="grow">
                  OS icon
                  <select
                    value={os}
                    onChange={(e) => setOs(e.currentTarget.value)}
                  >
                    {OS_CHOICES.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={agentForward}
                  onChange={(e) => setAgentForward(e.currentTarget.checked)}
                />
                Agent forwarding (remote host may use your local SSH agent)
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
                  <div className="field-row">
                    <label className="grow">
                      Name
                      <input
                        value={name}
                        onChange={(e) => setName(e.currentTarget.value)}
                        placeholder={
                          user && host ? `${user}@${host}` : "My server"
                        }
                      />
                    </label>
                    <label className="grow">
                      Group
                      <input
                        value={group}
                        onChange={(e) => setGroup(e.currentTarget.value)}
                        placeholder="(optional)"
                        list="saved-groups"
                      />
                      <datalist id="saved-groups">
                        {[
                          ...new Set(
                            saved.map((c) => c.group).filter(Boolean),
                          ),
                        ].map((g) => (
                          <option key={g} value={g} />
                        ))}
                      </datalist>
                    </label>
                  </div>
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
              {error && <div className="connect-error">{error}</div>}
            </div>
            <div className="host-modal-foot">
              {save && (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={saveOnly}
                  disabled={!host || !user}
                >
                  Save only
                </button>
              )}
              <button
                type="submit"
                className="primary-btn"
                disabled={connecting}
              >
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
        </div>
      )}

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
