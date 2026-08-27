// The terminal's font stack, and a place for the user to override it.
//
// Consolas and Cascadia Mono cover Latin and box drawing well but have
// no Arabic script at all, so Persian, Arabic and Urdu fell through to
// whatever the generic `monospace` keyword happened to resolve to —
// often a font with no coverage either, which renders empty boxes.
//
// Font fallback is per glyph, so listing Arabic-capable families after
// the monospace ones keeps Latin in Consolas while giving the rest of
// Unicode somewhere to land. The order walks Windows, then Linux, then
// macOS families.
//
// Note this fixes which glyphs appear, not how they are laid out: xterm
// does not do Arabic contextual shaping or bidirectional reordering, so
// the letters render in their isolated forms in logical order.

const KEY = "remotepal-term-font";

export const DEFAULT_TERM_FONT =
  "Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', 'Noto Sans Mono', " +
  "'Courier New', Tahoma, 'Segoe UI', 'Noto Naskh Arabic', 'Geeza Pro', " +
  "monospace";

const listeners = new Set<() => void>();

export function getTermFont(): string {
  return localStorage.getItem(KEY) || DEFAULT_TERM_FONT;
}

export function setTermFont(value: string): void {
  const v = value.trim();
  if (!v || v === DEFAULT_TERM_FONT) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, v);
  listeners.forEach((listener) => listener());
}

/** Open terminals re-read the font when it changes. */
export function subscribeTermFont(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------- reconnect

const RECONNECT_KEY = "remotepal-auto-reconnect";

/// How many times a dropped session retries before leaving it to you.
export const RECONNECT_ATTEMPTS = 4;

/// Backoff for attempt n (1-based): 1s, 2s, 4s, 8s. Long enough to let a
/// rebooting host come back, short enough to feel automatic.
export function reconnectDelay(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

export function autoReconnectEnabled(): boolean {
  return localStorage.getItem(RECONNECT_KEY) !== "0";
}

export function setAutoReconnect(on: boolean): void {
  localStorage.setItem(RECONNECT_KEY, on ? "1" : "0");
}
