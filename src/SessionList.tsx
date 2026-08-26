// A sidebar listing every open session, shown beside the terminal.
//
// The tab bar is the same navigation, but it runs out of room and
// truncates titles; a vertical list gives each session a full-width row,
// so with many open you can still tell them apart.

import { Cloud, X } from "lucide-react";
import OsIcon from "./osIcons";

export interface SessionItem {
  key: string;
  title: string;
  kind: "ssh" | "local" | "s3";
  /** OS slug for the icon: the remote's, or this machine's for a shell */
  os?: string;
  /** an SSH tab whose panes have all disconnected */
  dead?: boolean;
  /** second line — user@host, the shell, the bucket */
  detail?: string;
}

interface Props {
  items: SessionItem[];
  active: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
}

function SessionList({ items, active, onSelect, onClose }: Props) {
  return (
    <div className="session-list">
      <div className="session-list-head">Sessions</div>
      <div className="session-list-items">
        {items.map((item) => (
          <div
            key={item.key}
            className={
              "session-item" + (item.key === active ? " active" : "")
            }
            title={item.detail ? `${item.title} — ${item.detail}` : item.title}
            onClick={() => onSelect(item.key)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(item.key);
              }
            }}
          >
            {item.kind === "s3" ? (
              <Cloud size={15} className="session-icon" />
            ) : (
              <OsIcon os={item.os} size={16} />
            )}
            <span className="session-text">
              <span className="session-title">{item.title}</span>
              {item.detail && (
                <span className="session-detail">{item.detail}</span>
              )}
            </span>
            {item.kind === "ssh" && (
              <span className={"tab-dot" + (item.dead ? " dead" : "")} />
            )}
            <button
              type="button"
              className="session-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(item.key);
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SessionList;
