// A small, dependency-free Markdown renderer for AI answers. Supports the
// blocks that make an answer readable — GFM tables, bullet/numbered
// lists, fenced code, headings, paragraphs — plus inline code, bold,
// italic, and links. It builds React elements (no dangerouslySetInnerHTML),
// so remote/model text is always escaped. Unsupported syntax degrades to
// plain text rather than breaking.

import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Play } from "lucide-react";

/** Inline: `code`, **bold**, *italic*, [text](url). */
function renderInline(text: string): ReactNode[] {
  // fresh regex per call so recursion doesn't clobber lastIndex
  const re =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(<strong key={k}>{renderInline(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      out.push(<em key={k}>{renderInline(tok.slice(1, -1))}</em>);
    } else {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      if (link) {
        const url = link[2];
        out.push(
          <a
            key={k}
            className="ai-link"
            onClick={() => openUrl(url).catch(() => {})}
          >
            {link[1]}
          </a>,
        );
      } else {
        out.push(tok);
      }
    }
    last = m.index + tok.length;
    k++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function splitRow(row: string): string[] {
  const cells = row.split("|").map((c) => c.trim());
  if (cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

const isBlank = (l: string) => l.trim() === "";
const heading = (l: string) => /^(#{1,6})\s+(.*)$/.exec(l);
const unordered = (l: string) => /^\s*[-*+]\s+(.*)$/.exec(l);
const ordered = (l: string) => /^\s*\d+\.\s+(.*)$/.exec(l);
const tableSep = (l: string) => /^[\s|:-]*-[\s|:-]*$/.test(l) && l.includes("-");

function Markdown({
  text,
  onRunCommand,
}: {
  text: string;
  /** when given, fenced code blocks get a "run" button */
  onRunCommand?: (command: string) => void;
}) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // fenced code block
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const code = body.join("\n");
      blocks.push(
        <pre key={key++} className="ai-md-pre">
          {onRunCommand && code.trim() && (
            <button
              type="button"
              className="ai-md-run"
              title="Run this in the terminal"
              onClick={() => onRunCommand(code)}
            >
              <Play size={11} />
              run
            </button>
          )}
          <code>{code}</code>
        </pre>,
      );
      continue;
    }

    // heading
    const h = heading(line);
    if (h) {
      blocks.push(
        <div key={key++} className={`ai-md-h ai-md-h${h[1].length}`}>
          {renderInline(h[2])}
        </div>,
      );
      i++;
      continue;
    }

    // table: a row with pipes followed by a separator row
    if (line.includes("|") && i + 1 < lines.length && tableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} className="ai-md-table-wrap">
          <table className="ai-md-table">
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci}>{renderInline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci}>{renderInline(r[ci] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // list (grouped by first item's kind)
    if (unordered(line) || ordered(line)) {
      const isOrdered = !!ordered(line);
      const items: string[] = [];
      while (i < lines.length) {
        const mm = isOrdered ? ordered(lines[i]) : unordered(lines[i]);
        if (!mm) break;
        items.push(mm[1]);
        i++;
      }
      const list = items.map((it, ii) => <li key={ii}>{renderInline(it)}</li>);
      blocks.push(
        isOrdered ? (
          <ol key={key++} className="ai-md-list">
            {list}
          </ol>
        ) : (
          <ul key={key++} className="ai-md-list">
            {list}
          </ul>
        ),
      );
      continue;
    }

    // paragraph: consecutive plain lines, soft newlines preserved
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i])) {
      const l = lines[i];
      if (
        /^\s*```/.test(l) ||
        heading(l) ||
        unordered(l) ||
        ordered(l) ||
        (l.includes("|") && i + 1 < lines.length && tableSep(lines[i + 1]))
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    blocks.push(
      <p key={key++} className="ai-md-p">
        {para.map((l, li) => (
          <span key={li}>
            {li > 0 && <br />}
            {renderInline(l)}
          </span>
        ))}
      </p>,
    );
  }

  return <div className="ai-md">{blocks}</div>;
}

export default Markdown;
