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

/// A shell prompt carrying a command, e.g. "user@host:~$ systemctl status".
/// Deliberately loose: prompts vary wildly, and the worst case is that we
/// fall back to plain trailing output.
const PROMPT_WITH_COMMAND = /[$#]\s+(\S.*)$/;
/// A prompt sitting empty — where the cursor waits after a command ends.
const BARE_PROMPT = /[$#]\s*$/;

export interface LastCommand {
  command: string;
  output: string;
}

/**
 * The last command the user ran in this terminal and what it printed.
 *
 * Walks back through the buffer for the most recent prompt line that has
 * a command on it, and takes everything after it as the output. Returns
 * null when no prompt is recognisable (an unusual PS1, a full-screen
 * program like top), so callers can fall back to raw trailing lines.
 */
export function readLastCommand(
  id: number,
  maxLines = 300,
): LastCommand | null {
  const term = terminals.get(id);
  if (!term) return null;
  const buf = term.buffer.active;
  const end = buf.baseY + buf.cursorY;
  const start = Math.max(0, end - maxLines + 1);

  const lines: string[] = [];
  for (let i = start; i <= end; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  // the cursor usually sits on a fresh prompt; that isn't output
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length && BARE_PROMPT.test(lines[lines.length - 1])) lines.pop();

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PROMPT_WITH_COMMAND.exec(lines[i]);
    if (!m) continue;
    const command = m[1].trim();
    if (!command) continue;
    return {
      command,
      output: lines
        .slice(i + 1)
        .join("\n")
        .trimEnd(),
    };
  }
  return null;
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
