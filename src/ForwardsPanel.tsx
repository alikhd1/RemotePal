import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ForwardInfo {
  id: number;
  sessionId: number;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

interface Props {
  sessionId: number;
}

function ForwardsPanel({ sessionId }: Props) {
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");
  const [starting, setStarting] = useState(false);

  async function refresh() {
    try {
      setForwards(await invoke<ForwardInfo[]>("forwards_list", { sessionId }));
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStarting(true);
    try {
      await invoke<ForwardInfo>("forward_start", {
        sessionId,
        localPort: parseInt(localPort, 10) || 0,
        remoteHost: remoteHost.trim() || "localhost",
        remotePort: parseInt(remotePort, 10),
      });
      setLocalPort("");
      setRemotePort("");
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setStarting(false);
    }
  }

  async function stop(id: number) {
    try {
      await invoke("forward_stop", { id });
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="forwards-panel">
      <div className="forwards-title">Local port forwards</div>
      <div className="forwards-list">
        {forwards.map((f) => (
          <div key={f.id} className="forwards-row">
            <span className="forwards-desc">
              127.0.0.1:{f.localPort} → {f.remoteHost}:{f.remotePort}
            </span>
            <button type="button" title="Stop" onClick={() => stop(f.id)}>
              ×
            </button>
          </div>
        ))}
        {forwards.length === 0 && (
          <div className="files-empty">No active forwards</div>
        )}
      </div>
      <form className="forwards-form" onSubmit={add}>
        <input
          className="fw-port"
          value={localPort}
          onChange={(e) => setLocalPort(e.currentTarget.value)}
          placeholder="local (auto)"
          inputMode="numeric"
        />
        <span>→</span>
        <input
          className="fw-host"
          value={remoteHost}
          onChange={(e) => setRemoteHost(e.currentTarget.value)}
          placeholder="remote host"
        />
        <input
          className="fw-port"
          value={remotePort}
          onChange={(e) => setRemotePort(e.currentTarget.value)}
          placeholder="port"
          inputMode="numeric"
          required
        />
        <button type="submit" disabled={starting}>
          Add
        </button>
      </form>
      {error && <div className="files-error">{error}</div>}
    </div>
  );
}

export default ForwardsPanel;
