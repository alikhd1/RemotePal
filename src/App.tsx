import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TerminalPane from "./TerminalPane";
import "./App.css";

interface SessionInfo {
  id: number;
  title: string;
}

function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setError(null);
    try {
      const id = await invoke<number>("ssh_connect", {
        host,
        port: parseInt(port, 10) || 22,
        user,
        password: password || null,
        keyPath: keyPath || null,
      });
      setSession({ id, title: `${user}@${host}` });
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  }

  if (session) {
    return (
      <TerminalPane
        id={session.id}
        title={session.title}
        onExit={() => setSession(null)}
      />
    );
  }

  return (
    <div className="connect-screen">
      <form className="connect-form" onSubmit={connect}>
        <h1>RemotePal</h1>
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
          />
        </label>
        <button type="submit" disabled={connecting}>
          {connecting ? "Connecting…" : "Connect"}
        </button>
        {error && <div className="connect-error">{error}</div>}
      </form>
    </div>
  );
}

export default App;
