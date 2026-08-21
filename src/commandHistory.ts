// Commands sent from the compose bar, most recent first. Kept in
// localStorage so recall and autocompletion survive restarts. This is the
// app's own history — it does not read the remote shell's ~/.bash_history.

const KEY = "remotepal-cmd-history";
const MAX = 200;

export function getHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/** Record a sent command; moves duplicates to the front. */
export function pushHistory(command: string): void {
  const cmd = command.trim();
  if (!cmd) return;
  const next = [cmd, ...getHistory().filter((c) => c !== cmd)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage full or unavailable — history is best-effort
  }
}
