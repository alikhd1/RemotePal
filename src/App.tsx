import { useState } from "react";
import ConnectForm from "./ConnectForm";
import TerminalPane from "./TerminalPane";
import "./App.css";

interface SessionInfo {
  id: number;
  title: string;
  disconnected: boolean;
}

function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // active session id; null shows the connect view ("+" tab)
  const [active, setActive] = useState<number | null>(null);

  function addSession(id: number, title: string) {
    setSessions((prev) => [...prev, { id, title, disconnected: false }]);
    setActive(id);
  }

  function closeTab(id: number) {
    const idx = sessions.findIndex((s) => s.id === id);
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (active === id) {
      setActive(next.length ? next[Math.min(idx, next.length - 1)].id : null);
    }
  }

  function markDisconnected(id: number) {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, disconnected: true } : s)),
    );
  }

  return (
    <div className="app">
      <div className="tab-bar">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={
              "tab" +
              (active === s.id ? " active" : "") +
              (s.disconnected ? " disconnected" : "")
            }
            onClick={() => setActive(s.id)}
          >
            <span className="tab-title">{s.title}</span>
            <button
              className="tab-close"
              title="Close session"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(s.id);
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
      </div>
      <div className="panes">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="pane-holder"
            style={{ display: active === s.id ? undefined : "none" }}
          >
            <TerminalPane
              id={s.id}
              active={active === s.id}
              onClose={() => closeTab(s.id)}
              onDisconnected={() => markDisconnected(s.id)}
            />
          </div>
        ))}
        <div
          className="pane-holder"
          style={{ display: active === null ? undefined : "none" }}
        >
          <ConnectForm onConnected={addSession} />
        </div>
      </div>
    </div>
  );
}

export default App;
