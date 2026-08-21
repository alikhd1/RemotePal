import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ForwardInfo {
  id: number;
  sessionId: number;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

interface SavedForward {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

interface Props {
  sessionId: number;
  savedConnId?: string;
}

function ForwardsPanel({ sessionId, savedConnId }: Props) {
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [pinned, setPinned] = useState<SavedForward[]>([]);
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
    if (savedConnId) {
      invoke<{ id: string; forwards: SavedForward[] }[]>("connections_list")
        .then((list) => {
          const conn = list.find((c) => c.id === savedConnId);
          if (conn) setPinned(conn.forwards ?? []);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function isPinned(f: ForwardInfo): boolean {
    return pinned.some(
      (p) =>
        p.localPort === f.localPort &&
        p.remoteHost === f.remoteHost &&
        p.remotePort === f.remotePort,
    );
  }

  async function togglePin(f: ForwardInfo) {
    if (!savedConnId) return;
    const next = !isPinned(f);
    try {
      await invoke("forward_pin", {
        connId: savedConnId,
        localPort: f.localPort,
        remoteHost: f.remoteHost,
        remotePort: f.remotePort,
        pinned: next,
      });
      setPinned((prev) => {
        const without = prev.filter(
          (p) =>
            !(
              p.localPort === f.localPort &&
              p.remoteHost === f.remoteHost &&
              p.remotePort === f.remotePort
            ),
        );
        return next
          ? [
              ...without,
              {
                localPort: f.localPort,
                remoteHost: f.remoteHost,
                remotePort: f.remotePort,
              },
            ]
          : without;
      });
    } catch (err) {
      setError(String(err));
    }
  }

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
            <span>
              {savedConnId && (
                <button
                  type="button"
                  className={isPinned(f) ? "fw-pin pinned" : "fw-pin"}
                  title={
                    isPinned(f)
                      ? "Pinned: starts automatically on connect — click to unpin"
                      : "Pin: start automatically when this connection opens"
                  }
                  onClick={() => togglePin(f)}
                >
                  {isPinned(f) ? "★" : "☆"}
                </button>
              )}
              <button type="button" title="Stop" onClick={() => stop(f.id)}>
                ×
              </button>
            </span>
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
