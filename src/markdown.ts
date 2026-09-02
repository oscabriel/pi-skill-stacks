// Minimal markdown → styled-plain-text renderer for the overlay's skill
// viewer. Covers the subset skill files actually use — ATX headings, lists,
// fenced code, blockquotes, thematic breaks, frontmatter, and inline
// `code` / **bold** / [links] — and falls through to plain text for anything
// else. Output lines are ANSI-styled and wrapped ANSI-aware, so callers can
// pad/truncate them with the usual pi-tui helpers.

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** The slice of pi's Theme the renderer needs (OverlayTheme satisfies this). */
export interface MarkdownStyler {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST = /^(\s*)(?:([-*+])|(\d+[.)]))\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(```|~~~)/;
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]*\]\([^)\n]*\))/g;
/** A line that starts a table row (GFM). Escaped `\|` is not supported. */
const TABLE_ROW = /^\s*\|/;

export function renderMarkdown(text: string, width: number, styler: MarkdownStyler): string[] {
  if (text === "") return [];
  const w = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  const source = text.replace(/\r\n?/g, "\n").split("\n");

  let start = 0;
  if (source[0]?.trimEnd() === "---") {
    let end = 1;
    while (end < source.length && source[end]!.trimEnd() !== "---") end += 1;
    if (end < source.length) {
      for (let k = 0; k <= end; k += 1) pushDim(lines, source[k]!, w, styler);
      start = end + 1;
    }
  }

  let inFence = false;
  for (let i = start; i < source.length; i += 1) {
    const raw = source[i]!;
    if (inFence) {
      if (FENCE.test(raw)) inFence = false;
      else pushDim(lines, raw, w, styler);
      continue;
    }
    if (FENCE.test(raw)) {
      inFence = true;
      continue;
    }
    if (raw.trim() === "") {
      pushBlank(lines);
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      pushBlank(lines);
      pushWrapped(lines, styler.fg("accent", styler.bold(heading[2]!)), w);
      pushBlank(lines);
      continue;
    }
    if (TABLE_ROW.test(raw) && isDivider(source[i + 1] ?? "")) {
      let end = i + 2;
      while (end < source.length && TABLE_ROW.test(source[end]!)) end += 1;
      renderTable(
        lines,
        parseCells(raw),
        source.slice(i + 2, end).map(parseCells),
        w,
        styler,
      );
      i = end - 1;
      continue;
    }
    if (HR.test(raw)) {
      pushBlank(lines);
      lines.push(styler.fg("dim", "─".repeat(w)));
      continue;
    }
    const list = LIST.exec(raw);
    if (list) {
      const indent = list[1] ?? "";
      const marker = list[2] ? "• " : `${list[3]} `;
      pushWrapped(lines, `${indent}${marker}${inline(list[4]!, styler)}`, w, indent.length + marker.length);
      continue;
    }
    const quote = QUOTE.exec(raw);
    if (quote) {
      pushWrapped(lines, styler.fg("muted", `> ${quote[1]}`), w, 2);
      continue;
    }
    pushWrapped(lines, inline(raw, styler), w);
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** `` `code` `` → accent, `**bold**` → bold, `[text](url)` → accent text without the url. */
function inline(text: string, styler: MarkdownStyler): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    out += text.slice(last, match.index);
    if (match[1]) out += styler.fg("accent", match[1].slice(1, -1));
    else if (match[2]) out += styler.bold(match[2]!.slice(2, -2));
    else {
      const label = /^\[([^\]]*)\]/.exec(match[0])?.[1] ?? "";
      if (label) out += styler.fg("accent", label);
    }
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

function pushBlank(lines: string[]) {
  if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
}

/** Wrap `text`, indenting continuation lines by `hangIndent` columns. */
function pushWrapped(lines: string[], text: string, width: number, hangIndent = 0) {
  const parts = wrapTextWithAnsi(text, Math.max(1, width - hangIndent));
  lines.push(parts[0] ?? "");
  for (const part of parts.slice(1)) lines.push(" ".repeat(hangIndent) + part);
}

/** Style each already-wrapped part so styling survives across continuation lines. */
function pushDim(lines: string[], text: string, width: number, styler: MarkdownStyler) {
  for (const part of wrapTextWithAnsi(text, width)) lines.push(styler.fg("dim", part));
}

// ---- tables ----

/** GFM delimiter row: every `|`-separated cell is just dashes with optional colons. */
const isDivider = (line: string) => {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
};

/** Split a table row into trimmed cells, dropping the edge pipes. */
const parseCells = (line: string) => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
};

/** Render a table as aligned columns: bold header, dim rule, cells wrap in-column. */
function renderTable(
  lines: string[],
  header: string[],
  body: string[][],
  width: number,
  styler: MarkdownStyler,
) {
  const cols = Math.max(header.length, ...body.map((row) => row.length), 1);
  const cell = (row: string[], c: number) => row[c] ?? "";
  const widths: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    widths.push(Math.max(3, visibleWidth(cell(header, c)), ...body.map((row) => visibleWidth(cell(row, c)))));
  }
  const gap = " │ ".length * (cols - 1);
  const avail = Math.max(0, width - gap);
  const floors: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    // a column is never squeezed below its longest word (words would break mid-word)
    floors.push(Math.min(12, Math.max(3, longestWord([cell(header, c), ...body.map((row) => cell(row, c))]))));
  }
  const final = fitColumns(widths, floors, avail);

  const row = (cells: string[], styled: boolean) => {
    const wrapped = cells.map((text, c) =>
      wrapTextWithAnsi(styled ? styler.bold(inline(text, styler)) : inline(text, styler), final[c]!),
    );
    const height = Math.max(...wrapped.map((parts) => parts.length), 1);
    for (let line = 0; line < height; line += 1) {
      const parts = wrapped.map((column, c) => {
        const text = column[line] ?? "";
        return text + " ".repeat(Math.max(0, final[c]! - visibleWidth(text)));
      });
      lines.push(parts.join(" │ ").trimEnd());
    }
  };

  pushBlank(lines);
  row(header, true);
  lines.push(styler.fg("dim", final.map((w) => "─".repeat(w)).join("─┼─")));
  for (const entry of body) row(entry, false);
  pushBlank(lines);
}

/** Width of the longest word across a column's cells. */
const longestWord = (texts: string[]) =>
  Math.max(...texts.flatMap((text) => text.split(/\s+/).map((word) => word.length)), 1);

/**
 * Fit column widths into `avail`: every column keeps its longest word intact,
 * leftover space is shared out in proportion to how much each column wanted.
 */
function fitColumns(natural: number[], floors: number[], avail: number): number[] {
  const total = natural.reduce((sum, w) => sum + w, 0);
  if (total <= avail) return natural;
  const floorTotal = floors.reduce((sum, w) => sum + w, 0);
  if (floorTotal >= avail) {
    // nothing to distribute; squeeze the floors so lines still fit (words will break)
    const shrunk = [...floors];
    let sum = floorTotal;
    while (sum > avail && shrunk.some((w) => w > 1)) {
      const widest = Math.max(...shrunk);
      shrunk[shrunk.indexOf(widest)] = widest - 1;
      sum -= 1;
    }
    return shrunk;
  }
  const spare = avail - floorTotal;
  const demand = natural.map((w, i) => w - floors[i]!);
  const demandTotal = demand.reduce((sum, d) => sum + d, 0);
  const widths = natural.map((_, i) => floors[i]! + Math.floor((demand[i]! * spare) / demandTotal));
  let sum = widths.reduce((sum, w) => sum + w, 0);
  const order = natural.map((_, i) => i).sort((a, b) => natural[b]! - natural[a]!);
  for (let i = 0; sum < avail; i += 1) {
    const j = order[i % widths.length]!;
    if (widths[j]! < natural[j]!) {
      widths[j]! += 1;
      sum += 1;
    }
  }
  return widths;
}
