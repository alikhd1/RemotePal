import { useState } from "react";
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
  ScrollText,
  SquareTerminal,
  X,
} from "lucide-react";
import ConnectForm from "./ConnectForm";
import TerminalPane from "./TerminalPane";
import LocalTerminal from "./LocalTerminal";
import S3Browser from "./S3Browser";
import SplitLayout from "./SplitLayout";
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

  function patchSshTab(key: string, fn: (t: Tab & { kind: "ssh" }) => Tab) {
    setTabs((prev) =>
      prev.map((t) => (t.key === key && t.kind === "ssh" ? fn(t) : t)),
    );
  }

  function addSshTab(
    sshId: number,
    title: string,
    meta: SessionMeta,
    opts?: { openFiles?: boolean; savedId?: string },
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

  function closeTab(key: string) {
    const idx = tabs.findIndex((t) => t.key === key);
    const tab = tabs[idx];
    const next = tabs.filter((t) => t.key !== key);
    setTabs(next);
    if (tab?.kind === "ssh") {
      forgetPanes(leaves(tab.root).map((p) => p.paneId));
    }
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
              onClick={() => setActive(t.key)}
            >
              {t.kind === "ssh" ? (
                <OsIcon os={leaves(t.root)[0]?.meta.os} size={16} />
              ) : t.kind === "local" ? (
                <SquareTerminal size={13} className="tab-kind-icon" />
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
                  closeTab(t.key);
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
        <div className="tab-bar-right">
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
                onClick={() => toggleIn(setAutoPwOpen, activePaneId)}
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
      {splitError && (
        <div className="app-error">
          <span>{splitError}</span>
          <button title="Dismiss" onClick={() => setSplitError(null)}>
            ×
          </button>
        </div>
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
                onExit={() => {}}
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
  );
}

export default App;
