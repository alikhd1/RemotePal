// OS / distro icon tiles for hosts, Netcatty-style: a rounded colored
// square with a white glyph. Glyphs come from simple-icons (CC0);
// Windows' four panes are drawn by hand because simple-icons dropped
// Microsoft marks. Slugs match ssh.rs::parse_os_slug — keep in sync.

import {
  siAlmalinux,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siNetbsd,
  siNixos,
  siOpenbsd,
  siOpensuse,
  siRaspberrypi,
  siRedhat,
  siRockylinux,
  siUbuntu,
} from "simple-icons";

interface OsEntry {
  label: string;
  color: string;
  /** 24x24 svg path */
  path: string;
}

const WINDOWS_PATH =
  "M3 3h8.6v8.6H3V3zm9.4 0H21v8.6h-8.6V3zM3 12.4h8.6V21H3v-8.6zm9.4 0H21V21h-8.6v-8.6z";

// A tiny server rack for hosts with no known OS.
const SERVER_PATH =
  "M4 3h16a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 20 10H4a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 4 3zm0 11h16a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 20 21H4a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 4 14zm2-8.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zm0 11a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5z";

export const OS_ICONS: Record<string, OsEntry> = {
  ubuntu: { label: "Ubuntu", color: "#E95420", path: siUbuntu.path },
  debian: { label: "Debian", color: "#A81D33", path: siDebian.path },
  fedora: { label: "Fedora", color: "#51A2DA", path: siFedora.path },
  centos: { label: "CentOS", color: "#932279", path: siCentos.path },
  redhat: { label: "Red Hat", color: "#EE0000", path: siRedhat.path },
  rocky: { label: "Rocky Linux", color: "#10B981", path: siRockylinux.path },
  alma: { label: "AlmaLinux", color: "#0F4266", path: siAlmalinux.path },
  arch: { label: "Arch Linux", color: "#1793D1", path: siArchlinux.path },
  alpine: { label: "Alpine", color: "#0D597F", path: siAlpinelinux.path },
  opensuse: { label: "openSUSE", color: "#73BA25", path: siOpensuse.path },
  kali: { label: "Kali Linux", color: "#367BF0", path: siKalilinux.path },
  gentoo: { label: "Gentoo", color: "#54487A", path: siGentoo.path },
  nixos: { label: "NixOS", color: "#5277C3", path: siNixos.path },
  mint: { label: "Linux Mint", color: "#71B340", path: siLinuxmint.path },
  raspbian: { label: "Raspberry Pi OS", color: "#A22846", path: siRaspberrypi.path },
  amazon: { label: "Amazon Linux", color: "#FF9900", path: siLinux.path },
  oracle: { label: "Oracle Linux", color: "#C74634", path: siLinux.path },
  linux: { label: "Linux", color: "#333333", path: siLinux.path },
  freebsd: { label: "FreeBSD", color: "#AB2B28", path: siFreebsd.path },
  openbsd: { label: "OpenBSD", color: "#F2CA30", path: siOpenbsd.path },
  netbsd: { label: "NetBSD", color: "#FF6600", path: siNetbsd.path },
  macos: { label: "macOS", color: "#4B5563", path: siApple.path },
  windows: { label: "Windows", color: "#0078D4", path: WINDOWS_PATH },
};

/** Picker choices: "" means unknown / auto-detect on next connect. */
export const OS_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "Auto-detect" },
  ...Object.entries(OS_ICONS).map(([value, e]) => ({ value, label: e.label })),
];

export function osLabel(os: string | undefined): string {
  return (os && OS_ICONS[os]?.label) || "Unknown OS";
}

interface Props {
  os?: string;
  size?: number;
  /** small green/red presence dot pinned to the tile's corner */
  live?: boolean;
  dead?: boolean;
}

function OsIcon({ os, size = 34, live, dead }: Props) {
  const entry = os ? OS_ICONS[os] : undefined;
  const glyph = size * 0.62;
  return (
    <span
      className="os-icon"
      title={entry?.label}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, size * 0.24),
        background: entry ? entry.color : "var(--os-fallback, #52525b)",
      }}
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill={entry?.color === "#F2CA30" ? "#1a1a1a" : "#ffffff"}
        aria-hidden
      >
        <path d={entry ? entry.path : SERVER_PATH} />
      </svg>
      {(live || dead) && (
        <span className={"os-icon-dot" + (dead ? " dead" : "")} />
      )}
    </span>
  );
}

export default OsIcon;
