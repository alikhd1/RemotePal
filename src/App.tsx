import { useState } from "react";
import ConnectForm from "./ConnectForm";
import TerminalPane from "./TerminalPane";
import S3Browser from "./S3Browser";
import type { SessionMeta } from "./SnippetsPanel";
import { THEME_NAMES, applyTheme, currentTheme, initTheme } from "./themes";
import "./App.css";

initTheme();

type Tab =
  | {
      kind: "ssh";
      key: string;
      sshId: number;
      title: string;
      meta: SessionMeta;
      disconnected: boolean;
    }
  | { kind: "s3"; key: string; storageId: string; title: string };

let nextS3TabSeq = 1;

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  // active tab key; null shows the connect view ("+" tab)
  const [active, setActive] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState<Set<string>>(new Set());
  const [forwardsOpen, setForwardsOpen] = useState<Set<string>>(new Set());
  const [snippetsOpen, setSnippetsOpen] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState(currentTheme());

  const activeTab = tabs.find((t) => t.key === active) ?? null;

  function addSshTab(
    sshId: number,
    title: string,
    meta: SessionMeta,
    opts?: { openFiles?: boolean },
  ) {
    const key = `ssh-${sshId}`;
    setTabs((prev) => [
      ...prev,
      { kind: "ssh", key, sshId, title, meta, disconnected: false },
    ]);
    if (opts?.openFiles) {
      setFilesOpen((prev) => new Set(prev).add(key));
    }
    setActive(key);
  }

  function addS3Tab(storageId: string, title: string) {
    const key = `s3-${nextS3TabSeq++}`;
    setTabs((prev) => [...prev, { kind: "s3", key, storageId, title }]);
    setActive(key);
  }

  function closeTab(key: string) {
    const idx = tabs.findIndex((t) => t.key === key);
    const next = tabs.filter((t) => t.key !== key);
    setTabs(next);
    setFilesOpen((prev) => {
      const n = new Set(prev);
      n.delete(key);
      return n;
    });
    if (active === key) {
      setActive(next.length ? next[Math.min(idx, next.length - 1)].key : null);
    }
  }

  function markDisconnected(key: string) {
    setTabs((prev) =>
      prev.map((t) =>
        t.key === key && t.kind === "ssh" ? { ...t, disconnected: true } : t,
      ),
    );
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

  return (
    <div className="app">
      <div className="tab-bar">
        {tabs.map((t) => (
          <div
            key={t.key}
            className={
              "tab" +
              (active === t.key ? " active" : "") +
              (t.kind === "ssh" && t.disconnected ? " disconnected" : "")
            }
            onClick={() => setActive(t.key)}
          >
            <span className="tab-title">
              {t.kind === "s3" ? `S3 · ${t.title}` : t.title}
            </span>
            <button
              className="tab-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.key);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className={"tab-new" + (active === null ? " active" : "")}
          title="New session"
          onClick={() => setActive(null)}
        >
          +
        </button>
        <div className="tab-bar-right">
          {activeTab?.kind === "ssh" && (
            <>
              <button
                className={
                  "files-toggle" +
                  (snippetsOpen.has(activeTab.key) ? " active" : "")
                }
                title="Toggle snippets"
                onClick={() => toggleIn(setSnippetsOpen, activeTab.key)}
              >
                Snippets
              </button>
              <button
                className={
                  "files-toggle" +
                  (forwardsOpen.has(activeTab.key) ? " active" : "")
                }
                title="Toggle port forwards"
                onClick={() => toggleIn(setForwardsOpen, activeTab.key)}
              >
                Forwards
              </button>
              <button
                className={
                  "files-toggle" +
                  (filesOpen.has(activeTab.key) ? " active" : "")
                }
                title="Toggle file browser"
                onClick={() => toggleIn(setFilesOpen, activeTab.key)}
              >
                Files
              </button>
            </>
          )}
          <select
            className="theme-select"
            title="Theme"
            value={theme}
            onChange={(e) => {
              applyTheme(e.currentTarget.value);
              setTheme(e.currentTarget.value);
            }}
          >
            {THEME_NAMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="panes">
        {tabs.map((t) => (
          <div
            key={t.key}
            className="pane-holder"
            style={{ display: active === t.key ? undefined : "none" }}
          >
            {t.kind === "ssh" ? (
              <TerminalPane
                id={t.sshId}
                active={active === t.key}
                showFiles={filesOpen.has(t.key)}
                showForwards={forwardsOpen.has(t.key)}
                showSnippets={snippetsOpen.has(t.key)}
                meta={t.meta}
                onClose={() => closeTab(t.key)}
                onDisconnected={() => markDisconnected(t.key)}
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
          <ConnectForm onConnected={addSshTab} onOpenS3={addS3Tab} />
        </div>
      </div>
    </div>
  );
}

export default App;
