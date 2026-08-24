// Arabic-script shaping for the terminal.
//
// xterm draws one cell at a time, so Arabic and Persian come out as
// isolated letterforms: the browser never sees a word, only single
// characters, and cursive joining is a property of the run.
//
// registerCharacterJoiner is the way out. A range handed back from it is
// drawn as one unit, so the text engine shapes that substring — the same
// mechanism programming-ligature addons use. We return the runs of
// Arabic-script characters and the letters join.
//
// Caveat worth knowing: joiners are only consulted by the WebGL
// renderer. Where WebGL is unavailable and xterm falls back to the DOM
// renderer, text stays unjoined.

/** Characters that take part in a cursive run. */
function isArabicScript(code: number): boolean {
  return (
    (code >= 0x0600 && code <= 0x06ff) || // Arabic
    (code >= 0x0750 && code <= 0x077f) || // Arabic Supplement
    (code >= 0x0870 && code <= 0x089f) || // Arabic Extended-B
    (code >= 0x08a0 && code <= 0x08ff) || // Arabic Extended-A
    (code >= 0xfb50 && code <= 0xfdff) || // Presentation Forms-A
    (code >= 0xfe70 && code <= 0xfeff) // Presentation Forms-B
  );
}

/**
 * Characters that sit inside a run without breaking it: the zero-width
 * joiner and non-joiner, which Persian uses in words like می‌رود.
 */
function isJoinControl(code: number): boolean {
  return code === 0x200c || code === 0x200d;
}

/**
 * Ranges of `text` to render as one unit, as registerCharacterJoiner
 * wants: sorted, [start, end), and no single-character runs since one
 * letter has nothing to join to.
 */
export function arabicRuns(text: string): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;

  for (let i = 0; i <= text.length; i++) {
    const code = i < text.length ? text.charCodeAt(i) : -1;
    // a join control only continues a run, it cannot open one
    const inRun =
      isArabicScript(code) || (start !== -1 && isJoinControl(code));

    if (inRun) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1) {
      let end = i;
      // do not let a run end on a dangling join control
      while (end > start && isJoinControl(text.charCodeAt(end - 1))) end--;
      if (end - start > 1) runs.push([start, end]);
      start = -1;
    }
  }
  return runs;
}
