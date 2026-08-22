// A thin strip above the terminal showing the connected server's vitals:
// user@host, CPU, memory, disk, network rates, load and uptime. The
// backend snapshots /proc + df on a dedicated exec channel; rates and
// CPU% come from the delta between two snapshots, so the first poll only
// establishes a baseline. Metrics the host doesn't expose (no /proc)
// are hidden rather than shown as zeros.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionMeta } from "./SnippetsPanel";
import OsIcon, { osLabel } from "./osIcons";
import {
  Activity,
  Clock,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  X,
} from "lucide-react";

interface Stats {
  cores: number;
  load1: number;
  cpuTotal: number;
  cpuIdle: number;
  memTotalKb: number;
  memAvailKb: number;
  diskTotalKb: number;
  diskUsedKb: number;
  netRx: number;
  netTx: number;
  uptimeSecs: number;
}

interface Props {
  sessionId: number;
  meta: SessionMeta;
  /** paused while the tab is hidden or the session is dead */
  active: boolean;
  /** only offered when the tab has more than one pane — closing the last
   *  one would really be closing the tab, which the tab's own X does */
  onClose?: () => void;
}

const POLL_MS = 5000;

function fmtBytes(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`;
  return `${Math.round(kb)}K`;
}

function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024)
    return `${(bytesPerSec / 1024 / 1024).toFixed(1)}M/s`;
  if (bytesPerSec >= 1024) return `${Math.round(bytesPerSec / 1024)}K/s`;
  return `${Math.round(bytesPerSec)}B/s`;
}

function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ServerInfoBar({ sessionId, meta, active, onClose }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [cpuPct, setCpuPct] = useState<number | null>(null);
  const [rates, setRates] = useState<{ rx: number; tx: number } | null>(null);
  const prevRef = useRef<{ s: Stats; at: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;

    async function poll() {
      try {
        const s = await invoke<Stats>("server_stats", { id: sessionId });
        if (!alive) return;
        const now = Date.now();
        const prev = prevRef.current;
        if (prev) {
          const dt = (now - prev.at) / 1000;
          // CPU% from the jiffy delta (idle vs total)
          const dTotal = s.cpuTotal - prev.s.cpuTotal;
          const dIdle = s.cpuIdle - prev.s.cpuIdle;
          if (dTotal > 0) {
            setCpuPct(
              Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)),
            );
          }
          if (dt > 0 && (s.netRx > 0 || s.netTx > 0)) {
            setRates({
              rx: Math.max(0, (s.netRx - prev.s.netRx) / dt),
              tx: Math.max(0, (s.netTx - prev.s.netTx) / dt),
            });
          }
        }
        prevRef.current = { s, at: now };
        setStats(s);
      } catch {
        // session closed or host without /proc — keep the last values
      }
    }

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId, active]);

  const memUsedPct =
    stats && stats.memTotalKb > 0
      ? ((stats.memTotalKb - stats.memAvailKb) / stats.memTotalKb) * 100
      : null;
  const diskPct =
    stats && stats.diskTotalKb > 0
      ? (stats.diskUsedKb / stats.diskTotalKb) * 100
      : null;

  return (
    <div className="server-info">
      <span
        className="si-host"
        title={`${meta.name ? `${meta.name} — ` : ""}${meta.user}@${meta.host}:${meta.port} — ${osLabel(meta.os)}`}
      >
        <OsIcon os={meta.os} size={14} />
        {meta.name && meta.name !== meta.host ? (
          <>
            <span className="si-name">{meta.name}</span>
            <span className="si-dim">
              {meta.user}@{meta.host}
            </span>
          </>
        ) : (
          <>
            {meta.user}@{meta.host}
          </>
        )}
      </span>

      {cpuPct !== null && (
        <span className="si-item" title="CPU usage">
          <Cpu size={12} className="si-icon" />
          {Math.round(cpuPct)}%
          {stats && stats.cores > 0 && (
            <span className="si-dim">({stats.cores}C)</span>
          )}
        </span>
      )}

      {memUsedPct !== null && stats && (
        <span
          className="si-item"
          title={`Memory: ${fmtBytes(stats.memTotalKb - stats.memAvailKb)} of ${fmtBytes(stats.memTotalKb)} used`}
        >
          <MemoryStick size={12} className="si-icon" />
          {fmtBytes(stats.memTotalKb - stats.memAvailKb)}/
          {fmtBytes(stats.memTotalKb)}
          <span className="si-dim">({Math.round(memUsedPct)}%)</span>
        </span>
      )}

      {diskPct !== null && stats && (
        <span
          className="si-item"
          title={`Disk /: ${fmtBytes(stats.diskUsedKb)} of ${fmtBytes(stats.diskTotalKb)} used`}
        >
          <HardDrive size={12} className="si-icon" />
          {fmtBytes(stats.diskTotalKb)}
          <span className="si-dim">({Math.round(diskPct)}%)</span>
        </span>
      )}

      {rates && (
        <span className="si-item" title="Network throughput (all interfaces)">
          <Network size={12} className="si-icon" />↓{fmtRate(rates.rx)} ↑
          {fmtRate(rates.tx)}
        </span>
      )}

      {stats && stats.load1 > 0 && (
        <span className="si-item" title="Load average (1 minute)">
          <Activity size={12} className="si-icon" />
          {stats.load1.toFixed(2)}
        </span>
      )}

      {stats && stats.uptimeSecs > 0 && (
        <span className="si-item" title="Uptime since last boot">
          <Clock size={12} className="si-icon" />
          {fmtUptime(stats.uptimeSecs)}
        </span>
      )}

      {!stats && <span className="si-dim">reading server info…</span>}

      {onClose && (
        <button
          type="button"
          className="si-close"
          title="Close this pane (Ctrl+Shift+W)"
          onClick={onClose}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export default ServerInfoBar;
