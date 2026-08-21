// Cross-pane access to live xterm buffers. Each TerminalPane registers
// its Terminal instance by sshId; the AI panel reads recent output from
// any session (even one docked in a different pane) to answer the
// `read_terminal` tool. Kept out of App.tsx so panes stay self-contained.

import type { Terminal } from "@xterm/xterm";

const terminals = new Map<number, Terminal>();

export function registerTerminal(id: number, term: Terminal): void {
  terminals.set(id, term);
}

export function unregisterTerminal(id: number): void {
  terminals.delete(id);
}

/** Recent visible lines of a session's terminal, or null if not live. */
export function readTerminal(id: number, maxLines = 200): string | null {
  const term = terminals.get(id);
  if (!term) return null;
  const buf = term.buffer.active;
  const end = buf.baseY + buf.cursorY; // last row with content
  const start = Math.max(0, end - maxLines + 1);
  const lines: string[] = [];
  for (let i = start; i <= end; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  // drop trailing blank lines so the model isn't fed a wall of whitespace
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}
