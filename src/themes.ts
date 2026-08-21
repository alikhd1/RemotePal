import type { ITheme } from "@xterm/xterm";

// Palettes carried over from the PyQt app (terminal.py THEMES).

interface AppTheme {
  bg: string;
  panel: string;
  border: string;
  fg: string;
  fgDim: string;
  accent: string;
  danger: string;
}

export interface Theme {
  app: AppTheme;
  term: ITheme;
}

export const THEMES: Record<string, Theme> = {
  "One Dark": {
    app: {
      bg: "#1e1e1e",
      panel: "#252526",
      border: "#3c3c3c",
      fg: "#d4d4d4",
      fgDim: "#9da0a6",
      accent: "#61afef",
      danger: "#e06c75",
    },
    term: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#d4d4d4",
      black: "#3f3f3f",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#d19a66",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#d4d4d4",
      brightBlack: "#7f848e",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  Light: {
    app: {
      bg: "#fafafa",
      panel: "#f0f0f0",
      border: "#d0d0d0",
      fg: "#383a42",
      fgDim: "#696c77",
      accent: "#4078f2",
      danger: "#e45649",
    },
    term: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#383a42",
      black: "#383a42",
      red: "#e45649",
      green: "#50a14f",
      yellow: "#c18401",
      blue: "#4078f2",
      magenta: "#a626a4",
      cyan: "#0184bc",
      white: "#a0a1a7",
      brightBlack: "#696c77",
      brightRed: "#e45649",
      brightGreen: "#50a14f",
      brightYellow: "#c18401",
      brightBlue: "#4078f2",
      brightMagenta: "#a626a4",
      brightCyan: "#0184bc",
      brightWhite: "#101012",
    },
  },
  "Solarized Dark": {
    app: {
      bg: "#002b36",
      panel: "#073642",
      border: "#0e4956",
      fg: "#839496",
      fgDim: "#586e75",
      accent: "#268bd2",
      danger: "#dc322f",
    },
    term: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#839496",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#859900",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  Nord: {
    app: {
      bg: "#2e3440",
      panel: "#3b4252",
      border: "#4c566a",
      fg: "#d8dee9",
      fgDim: "#8f9aae",
      accent: "#81a1c1",
      danger: "#bf616a",
    },
    term: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
};

export const THEME_NAMES = Object.keys(THEMES);

const STORAGE_KEY = "remotepal-theme";
let current =
  localStorage.getItem(STORAGE_KEY) && THEMES[localStorage.getItem(STORAGE_KEY)!]
    ? localStorage.getItem(STORAGE_KEY)!
    : "One Dark";
const listeners = new Set<() => void>();

export function currentTheme(): string {
  return current;
}

export function getTermTheme(): ITheme {
  return THEMES[current].term;
}

export function applyTheme(name: string) {
  if (!THEMES[name]) return;
  current = name;
  localStorage.setItem(STORAGE_KEY, name);
  const app = THEMES[name].app;
  const root = document.documentElement.style;
  root.setProperty("--bg", app.bg);
  root.setProperty("--panel", app.panel);
  root.setProperty("--border", app.border);
  root.setProperty("--fg", app.fg);
  root.setProperty("--fg-dim", app.fgDim);
  root.setProperty("--accent", app.accent);
  root.setProperty("--danger", app.danger);
  listeners.forEach((listener) => listener());
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function initTheme() {
  applyTheme(current);
}
