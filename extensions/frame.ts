// Shared drawing helpers for the /stacks overlay and its dialogs. Every helper
// returns lines of exactly the requested width so overlays keep a straight edge.

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Minimal slice of pi's Theme the overlay touches (kept small so tests can fake it). */
export interface OverlayTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: "selectedBg" | "customMessageBg", text: string): string;
  bold(text: string): string;
}

/** Truncate or right-pad `text` to exactly `width` columns. */
export function padToWidth(text: string, width: number) {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/** `┌─ label ────┐` or `└─ label ────┘`, exactly `width` wide. */
export function frameEdge(theme: OverlayTheme, width: number, label: string, top: boolean) {
  const left = top ? "┌" : "└";
  const right = top ? "┐" : "┘";
  const text = `─ ${label} `;
  const remaining = Math.max(0, width - visibleWidth(text) - 2);
  return theme.fg(
    "borderAccent",
    truncateToWidth(`${left}${text}${"─".repeat(remaining)}${right}`, width, ""),
  );
}

/** `│ content │` with one column of padding inside each border, exactly `width` wide. */
export function frameRow(theme: OverlayTheme, width: number, content: string) {
  const edge = theme.fg("borderAccent", "│");
  return padToWidth(`${edge} ${padToWidth(content, frameInnerWidth(width))} ${edge}`, width);
}

/** Width available to content inside `frameRow`. */
export const frameInnerWidth = (width: number) => Math.max(0, width - 4);

/** Word-wrap plain text to `width` display columns; over-long words are hard-split. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (visibleWidth(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      let rest = word;
      while (visibleWidth(rest) > width) {
        let cut = width;
        while (cut > 1 && visibleWidth(rest.slice(0, cut)) > width) cut -= 1;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) out.push(line);
  }
  return out;
}
