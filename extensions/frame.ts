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
