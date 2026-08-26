import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  Cloud,
  Columns2,
  FolderClosed,
  KeyRound,
  Network,
  Plus,
  Rows2,
  PanelLeft,
  ScrollText,
  SquareTerminal,
  X,
} from "lucide-react";
import ConnectForm from "./ConnectForm";
import TerminalPane from "./TerminalPane";
import LocalTerminal from "./LocalTerminal";
import S3Browser from "./S3Browser";
import SplitLayout from "./SplitLayout";
import SessionList, { type SessionItem } from "./SessionList";
import OsIcon from "./osIcons";
import { Select } from "./Dropdown";
import {
  findPane,
  leaves,
  removeLeaf,
  setRatioAt,
  splitLeaf,
  updatePane,
  type PaneNode,
  type SplitDir,
  type SshPane,
} from "./splitTree";
import type { SessionMeta } from "./SnippetsPanel";
import { THEMES, THEME_NAMES, applyTheme, currentTheme, initTheme } from "./themes";
import "./App.css";

initTheme();

type Tab =
  | {
      kind: "ssh";
      key: string;
      title: string;
      root: PaneNode;
      activePaneId: string;
    }
  | { kind: "s3"; key: string; storageId: string; title: string }
  | { kind: "local"; key: string; title: string; shell?: string };

const SIDEBAR_KEY = "remotepal-session-sidebar";

let nextTabSeq = 1;
let nextPaneSeq = 1;

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  // active tab key; null shows the connect view ("+" tab)
  const [active, setActive] = useState<string | null>(null);
  // panel visibility, keyed by paneId (stable across reconnects)
  const [filesOpen, setFilesOpen] = useState<Set<string>>(new Set());
  const [forwardsOpen, setForwardsOpen] = useState<Set<string>>(new Set());
  const [snippetsOpen, setSnippetsOpen] = useState<Set<string>>(new Set());
  const [aiOpen, setAiOpen] = useState<Set<string>>(new Set());
  const [autoPwOpen, setAutoPwOpen] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState(currentTheme());
  const [splitError, setSplitError] = useState<string | null>(null);
  // which direction is mid-split; duplicating a session opens a whole new
  // SSH connection, so the buttons stay busy until it lands
  const [splitting, setSplitting] = useState<SplitDir | null>(null);
  // this machine's OS slug, so local tabs carry its logo like SSH tabs do
  const [localOs, setLocalOs] = useState<string | undefined>();
  // local tabs whose shell has exited — nothing left to lose on close
  const [exitedLocals, setExitedLocals] = useState<Set<string>>(new Set());
  // tab awaiting a close confirmation
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) !== "0",
  );

  function toggleSidebar() {
    setSidebar((on) => {
      localStorage.setItem(SIDEBAR_KEY, on ? "0" : "1");
      return !on;
    });
  }

  const stripRef = useRef<HTMLDivElement>(null);

  // a vertical wheel over the strip walks it sideways; it is a
  // horizontal list and most mice have no horizontal wheel
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    function onWheel(this: HTMLElement, e: WheelEvent) {
      if (e.deltaX !== 0 || e.shiftKey) return;
      if (this.scrollWidth <= this.clientWidth) return;
      e.preventDefault();
      this.scrollLeft += e.deltaY;
    }
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  // keep the tab you switched to visible when the strip has scrolled
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(".tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  // Tab keys are claimed before the terminal sees them, so they work while
  // a session has focus. Digits and Ctrl+Tab are not bindings a shell
  // wants, unlike Ctrl+W, which readline uses to kill a word.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && /^[1-9]$/.test(e.key)) {
        if (tabs.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const n = Number(e.key);
        // 9 is "last tab", as it is in browsers
        const idx = n === 9 ? tabs.length - 1 : Math.min(n - 1, tabs.length - 1);
        setActive(tabs[idx].key);
        return;
      }
      const cycles =
        (e.ctrlKey && e.key === "Tab") ||
        (mod && (e.key === "PageUp" || e.key === "PageDown"));
      if (cycles && tabs.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        const back = e.shiftKey || e.key === "PageUp";
        const at = tabs.findIndex((t) => t.key === active);
        const from = at === -1 ? 0 : at;
        const next = (from + (back ? -1 : 1) + tabs.length) % tabs.length;
        setActive(tabs[next].key);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tabs, active]);

  useEffect(() => {
    invoke<{ os: string }>("local_info")
      .then((i) => setLocalOs(i.os))
      .catch(() => {});
  }, []);

  const activeTab = tabs.find((t) => t.key === active) ?? null;
  const liveSessions = tabs.flatMap((t) =>
    t.kind === "ssh"
      ? leaves(t.root)
          .filter((p) => !p.disconnected)
          .map((p) => ({ id: p.sshId, meta: p.meta }))
      : [],
  );
  const activeSavedIds = new Set(
    tabs.flatMap((t) =>
      t.kind === "ssh"
        ? leaves(t.root).flatMap((p) =>
            !p.disconnected && p.savedId ? [p.savedId] : [],
          )
        : [],
    ),
  );

  const sessionItems: SessionItem[] = tabs.map((t) => {
    if (t.kind === "ssh") {
      const panes = leaves(t.root);
      const meta = panes[0]?.meta;
      return {
        key: t.key,
        title: t.title,
        kind: "ssh",
        os: meta?.os,
        dead: panes.some((p) => p.disconnected),
        detail: meta ? `${meta.user}@${meta.host}` : undefined,
      };
    }
    if (t.kind === "local") {
      return { key: t.key, title: t.title, kind: "local", os: localOs };
    }
    return { key: t.key, title: t.title, kind: "s3", detail: "S3" };
  });

  function patchSshTab(key: string, fn: (t: Tab & { kind: "ssh" }) => Tab) {
    setTabs((prev) =>
      prev.map((t) => (t.key === key && t.kind === "ssh" ? fn(t) : t)),
    );
  }

  function addSshTab(
    sshId: number,
    title: string,
    meta: SessionMeta,
    opts?: { openFiles?: boolean; savedId?: string; autoPassword?: boolean },
  ) {
    const key = `tab-${nextTabSeq++}`;
    const pane: SshPane = {
      paneId: `pane-${nextPaneSeq++}`,
      sshId,
      meta,
      savedId: opts?.savedId,
      disconnected: false,
    };
    setTabs((prev) => [
      ...prev,
      { kind: "ssh", key, title, root: { type: "leaf", pane }, activePaneId: pane.paneId },
    ]);
    if (opts?.openFiles) {
      setFilesOpen((prev) => new Set(prev).add(pane.paneId));
    }
    // the connection remembers this, so a session starts the way it was left
    if (opts?.autoPassword) {
      setAutoPwOpen((prev) => new Set(prev).add(pane.paneId));
    }
    setActive(key);
  }

  function addS3Tab(storageId: string, title: string) {
    const key = `tab-${nextTabSeq++}`;
    setTabs((prev) => [...prev, { kind: "s3", key, storageId, title }]);
    setActive(key);
  }

  function addLocalTab() {
    const key = `tab-${nextTabSeq++}`;
    setTabs((prev) => [...prev, { kind: "local", key, title: "Local shell" }]);
    setActive(key);
  }

  function forgetPanes(paneIds: string[]) {
    for (const setter of [
      setFilesOpen,
      setForwardsOpen,
      setSnippetsOpen,
      setAiOpen,
      setAutoPwOpen,
    ]) {
      setter((prev) => {
        const next = new Set(prev);
        paneIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  }

  /// Whether closing this tab throws work away. Sessions that already
  /// ended have nothing left to lose, so those close without asking.
  function tabIsLive(t: Tab): boolean {
    if (t.kind === "ssh") return leaves(t.root).some((p) => !p.disconnected);
    if (t.kind === "local") return !exitedLocals.has(t.key);
    return true; // s3: browsing state and any transfer in flight
  }

  /// What closing this tab costs, phrased for its kind.
  function closeWarning(t: Tab): string {
    if (t.kind === "s3") {
      return "is open. Closing the tab discards where you are, and cancels anything still transferring.";
    }
    if (t.kind === "local") {
      return "is running a shell. Closing the tab ends it.";
    }
    return "still has a live session. Closing the tab ends it, along with any file browser or forwards on it.";
  }

  function requestCloseTab(key: string) {
    const tab = tabs.find((t) => t.key === key);
    if (tab && tabIsLive(tab)) {
      setConfirmClose(key);
      return;
    }
    closeTab(key);
  }

  function closeTab(key: string) {
    const idx = tabs.findIndex((t) => t.key === key);
    const tab = tabs[idx];
    const next = tabs.filter((t) => t.key !== key);
    setTabs(next);
    if (tab?.kind === "ssh") {
      forgetPanes(leaves(tab.root).map((p) => p.paneId));
    }
    setExitedLocals((prev) => {
      if (!prev.has(key)) return prev;
      const out = new Set(prev);
      out.delete(key);
      return out;
    });
    if (active === key) {
      setActive(next.length ? next[Math.min(idx, next.length - 1)].key : null);
    }
  }

  function closePane(tabKey: string, paneId: string) {
    const tab = tabs.find((t) => t.key === tabKey);
    if (!tab || tab.kind !== "ssh") return;
    const rest = removeLeaf(tab.root, paneId);
    if (!rest) {
      closeTab(tabKey);
      return;
    }
    forgetPanes([paneId]);
    patchSshTab(tabKey, (t) => ({
      ...t,
      root: rest,
      activePaneId:
        t.activePaneId === paneId ? leaves(rest)[0].paneId : t.activePaneId,
    }));
  }

  async function splitPane(tabKey: string, paneId: string, dir: SplitDir) {
    if (splitting) return;
    const tab = tabs.find((t) => t.key === tabKey);
    if (!tab || tab.kind !== "ssh") return;
    const pane = findPane(tab.root, paneId);
    if (!pane || pane.disconnected) return;
    setSplitting(dir);
    try {
      const newId = await invoke<number>("ssh_duplicate", { id: pane.sshId });
      const newPane: SshPane = {
        paneId: `pane-${nextPaneSeq++}`,
        sshId: newId,
        meta: pane.meta,
        savedId: pane.savedId,
        disconnected: false,
      };
      if (autoPwOpen.has(paneId)) {
        setAutoPwOpen((prev) => new Set(prev).add(newPane.paneId));
      }
      patchSshTab(tabKey, (t) => ({
        ...t,
        root: splitLeaf(t.root, paneId, dir, newPane),
        activePaneId: newPane.paneId,
      }));
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      setSplitError(
        e?.kind === "hostKeyUnknown" || e?.kind === "hostKeyChanged"
          ? "Host key needs review — reconnect from the connect screen."
          : (e?.message ?? String(err)),
      );
    } finally {
      setSplitting(null);
    }
  }

  function setActivePane(tabKey: string, paneId: string) {
    setTabs((prev) =>
      prev.map((t) =>
        t.key === tabKey && t.kind === "ssh" && t.activePaneId !== paneId
          ? { ...t, activePaneId: paneId }
          : t,
      ),
    );
  }

  function markDisconnected(tabKey: string, paneId: string) {
    patchSshTab(tabKey, (t) => ({
      ...t,
      root: updatePane(t.root, paneId, { disconnected: true }),
    }));
  }

  function replacePaneSession(tabKey: string, paneId: string, newId: number) {
    patchSshTab(tabKey, (t) => ({
      ...t,
      root: updatePane(t.root, paneId, { sshId: newId, disconnected: false }),
    }));
  }

  function toggleIn(
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string,
  ) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const activePaneId =
    activeTab?.kind === "ssh" ? activeTab.activePaneId : null;

  return (
    <div className="app">
      <div className="tab-bar">
        <div className="tab-strip" ref={stripRef}>
        <button
          className={"tab-home" + (active === null ? " active" : "")}
          title="Hosts & vault"
          onClick={() => setActive(null)}
        >
          <SquareTerminal size={15} />
          <span>Hosts</span>
        </button>
        {tabs.map((t) => {
          const dead =
            t.kind === "ssh" && leaves(t.root).some((p) => p.disconnected);
          return (
            <div
              key={t.key}
              className={"tab" + (active === t.key ? " active" : "")}
              data-tab-key={t.key}
              onClick={() => setActive(t.key)}
              onMouseDown={(e) => {
                // stop the middle-click autoscroll cursor appearing
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  requestCloseTab(t.key);
                }
              }}
            >
              {t.kind === "ssh" ? (
                <OsIcon os={leaves(t.root)[0]?.meta.os} size={16} />
              ) : t.kind === "local" ? (
                <OsIcon os={localOs} size={16} />
              ) : (
                <Cloud size={13} className="tab-kind-icon" />
              )}
              <span className="tab-title">{t.title}</span>
              {t.kind === "ssh" && (
                <span className={"tab-dot" + (dead ? " dead" : "")} />
              )}
              <button
                className="tab-close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  requestCloseTab(t.key);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
        <button
          className={"tab-new" + (active === null ? " active" : "")}
          title="New session"
          onClick={() => setActive(null)}
        >
          <Plus size={15} />
        </button>
        <button
          className="tab-new"
          title="New local shell"
          onClick={addLocalTab}
        >
          <SquareTerminal size={15} />
        </button>
        </div>
        <div className="tab-bar-right">
          <Select
            size="sm"
            align="right"
            title="Theme"
            value={theme}
            options={THEME_NAMES.map((name) => ({
              value: name,
              label: name,
              icon: (
                <span
                  className="theme-swatch"
                  style={{
                    background: THEMES[name].app.bg,
                    borderColor: THEMES[name].app.border,
                  }}
                >
                  <i style={{ background: THEMES[name].app.accent }} />
                </span>
              ),
            }))}
            onChange={(name) => {
              applyTheme(name);
              setTheme(name);
            }}
          />
        </div>
      </div>
      {active !== null && (
        <div className="action-bar">
          <button
            className={
              "files-toggle icon-only sidebar-toggle" +
              (sidebar ? " active" : "")
            }
            title={sidebar ? "Hide session list" : "Show session list"}
            onClick={toggleSidebar}
          >
            <PanelLeft size={15} />
          </button>
          {activeTab?.kind === "ssh" && activePaneId && (
            <>
              <button
                className={
                  "files-toggle icon-only" +
                  (splitting === "row" ? " loading" : "")
                }
                title={
                  splitting
                    ? "Opening a new session…"
                    : "Split right (Ctrl+Shift+D)"
                }
                disabled={splitting !== null}
                onClick={() => splitPane(activeTab.key, activePaneId, "row")}
              >
                <Columns2 size={15} />
              </button>
              <button
                className={
                  "files-toggle icon-only" +
                  (splitting === "column" ? " loading" : "")
                }
                title={
                  splitting
                    ? "Opening a new session…"
                    : "Split down (Ctrl+Shift+E)"
                }
                disabled={splitting !== null}
                onClick={() => splitPane(activeTab.key, activePaneId, "column")}
              >
                <Rows2 size={15} />
              </button>
              <button
                className={
                  "files-toggle" +
                  (snippetsOpen.has(activePaneId) ? " active" : "")
                }
                title="Toggle snippets"
                onClick={() => toggleIn(setSnippetsOpen, activePaneId)}
              >
                <ScrollText size={15} />
                Snippets
              </button>
              <button
                className={
                  "files-toggle" +
                  (forwardsOpen.has(activePaneId) ? " active" : "")
                }
                title="Toggle port forwards"
                onClick={() => toggleIn(setForwardsOpen, activePaneId)}
              >
                <Network size={15} />
                Forwards
              </button>
              <button
                className={
                  "files-toggle" + (filesOpen.has(activePaneId) ? " active" : "")
                }
                title="Toggle file browser"
                onClick={() => toggleIn(setFilesOpen, activePaneId)}
              >
                <FolderClosed size={15} />
                Files
              </button>
              <button
                className={
                  "files-toggle icon-only" +
                  (autoPwOpen.has(activePaneId) ? " active" : "")
                }
                title="Auto-answer password prompts with this connection's saved password"
                onClick={() => {
                  toggleIn(setAutoPwOpen, activePaneId);
                  const pane =
                    activeTab?.kind === "ssh"
                      ? findPane(activeTab.root, activePaneId)
                      : null;
                  if (pane?.savedId) {
                    invoke("connection_set_auto_password", {
                      id: pane.savedId,
                      enabled: !autoPwOpen.has(activePaneId),
                    }).catch(() => {});
                  }
                }}
              >
                <KeyRound size={15} />
              </button>
              <button
                className={
                  "files-toggle ai-toggle" +
                  (aiOpen.has(activePaneId) ? " active" : "")
                }
                title="Toggle AI Copilot"
                onClick={() => toggleIn(setAiOpen, activePaneId)}
              >
                <Bot size={16} />
                AI Copilot
              </button>
            </>
          )}
        </div>
      )}
      {confirmClose && (
        <div className="modal-overlay" onMouseDown={() => setConfirmClose(null)}>
          <div className="pw-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="pw-dialog-head">
              <X size={16} />
              <h3>Close this tab?</h3>
            </div>
            <p className="pw-dialog-body">
              <strong>
                {tabs.find((t) => t.key === confirmClose)?.title ?? "This tab"}
              </strong>{" "}
              {(() => {
                const t = tabs.find((x) => x.key === confirmClose);
                return t ? closeWarning(t) : "will be closed.";
              })()}
            </p>
            <div className="pw-dialog-buttons">
              <button type="button" onClick={() => setConfirmClose(null)}>
                Keep open
              </button>
              <button
                type="button"
                className="accent-btn"
                autoFocus
                onClick={() => {
                  closeTab(confirmClose);
                  setConfirmClose(null);
                }}
              >
                Close tab
              </button>
            </div>
          </div>
        </div>
      )}
      {splitError && (
        <div className="app-error">
          <span>{splitError}</span>
          <button title="Dismiss" onClick={() => setSplitError(null)}>
            ×
          </button>
        </div>
      )}
      <div className="workspace">
        {sidebar && active !== null && tabs.length > 0 && (
          <SessionList
            items={sessionItems}
            active={active}
            onSelect={setActive}
            onClose={requestCloseTab}
          />
        )}
        <div className="panes">
        {tabs.map((t) => (
          <div
            key={t.key}
            className="pane-holder"
            style={{ display: active === t.key ? undefined : "none" }}
          >
            {t.kind === "ssh" ? (
              <SplitLayout
                root={t.root}
                onRatioChange={(path, ratio) =>
                  patchSshTab(t.key, (tab) => ({
                    ...tab,
                    root: setRatioAt(tab.root, path, ratio),
                  }))
                }
                renderLeaf={(pane) => (
                  <TerminalPane
                    id={pane.sshId}
                    active={active === t.key}
                    focused={t.activePaneId === pane.paneId}
                    showFiles={filesOpen.has(pane.paneId)}
                    showForwards={forwardsOpen.has(pane.paneId)}
                    showSnippets={snippetsOpen.has(pane.paneId)}
                    showAi={aiOpen.has(pane.paneId)}
                    autoPassword={autoPwOpen.has(pane.paneId)}
                    canClosePane={leaves(t.root).length > 1}
                    meta={pane.meta}
                    savedConnId={pane.savedId}
                    allSessions={liveSessions}
                    onFocus={() => setActivePane(t.key, pane.paneId)}
                    onSplit={(dir) => splitPane(t.key, pane.paneId, dir)}
                    onClose={() => closePane(t.key, pane.paneId)}
                    onDisconnected={() => markDisconnected(t.key, pane.paneId)}
                    onReconnected={(newId) =>
                      replacePaneSession(t.key, pane.paneId, newId)
                    }
                  />
                )}
              />
            ) : t.kind === "local" ? (
              <LocalTerminal
                active={active === t.key}
                shell={t.shell}
                onExit={() =>
                  setExitedLocals((prev) => new Set(prev).add(t.key))
                }
              />
            ) : (
              <S3Browser storageId={t.storageId} active={active === t.key} />
            )}
          </div>
        ))}
        <div
          className="pane-holder"
          style={{ display: active === null ? undefined : "none" }}
        >
          <ConnectForm
            onConnected={addSshTab}
            onOpenS3={addS3Tab}
            activeSavedIds={activeSavedIds}
          />
        </div>
        </div>
      </div>
    </div>
  );
}

export default App;
