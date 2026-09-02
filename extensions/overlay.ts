// Two-pane overlay for /stacks: stacks on the left (on/off, create, delete),
// members + available skills of the selected stack on the right (space moves
// a skill in or out of the stack). Every mutation is persisted immediately
// through the caller's callback; the ctx.reload() that makes pi pick the
// changes up happens once, after the overlay closes.
//
// StacksOverlay is a plain component (render/handleInput/invalidate) so it can
// be smoke-tested without a live pi session; showStacksOverlay wires it into
// the TUI.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { StackMap, StacksSummary } from "../src/core.ts";
import { StacksOverlayModel, type StacksOverlayInit } from "../src/overlay-model.ts";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface ApplyOutcome {
  summary: StacksSummary;
  missing: Record<string, string[]>;
  settingsChanged: boolean;
}

export type StacksPersist = (stacks: StackMap, disabledStacks: string[]) => ApplyOutcome;

export type Notify = (message: string, type?: "info" | "warning" | "error") => void;

export interface StacksOverlayCallbacks {
  persist: StacksPersist;
  notify: Notify;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm: (title: string, message: string) => Promise<boolean>;
  done: (result: { changed: boolean; outcome: ApplyOutcome | null }) => void;
}

/** Minimal slices of pi-tui's TUI and Theme the overlay touches. */
export interface OverlayTui {
  terminal: { rows: number };
  requestRender(): void;
}

export interface OverlayTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

interface InitWithDiscovered extends StacksOverlayInit {
  discovered: ReadonlySet<string>;
}

export class StacksOverlay {
  private readonly model: StacksOverlayModel;
  private readonly tui: OverlayTui;
  private readonly theme: OverlayTheme;
  private readonly callbacks: StacksOverlayCallbacks;
  private readonly discovered: ReadonlySet<string>;
  private changed = false;
  private lastOutcome: ApplyOutcome | null = null;
  private dialogOpen = false;

  constructor(tui: OverlayTui, theme: OverlayTheme, init: InitWithDiscovered, callbacks: StacksOverlayCallbacks) {
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;
    this.discovered = init.discovered;
    this.model = new StacksOverlayModel(init);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const { memberRows, availableRows } = this.sectionRows();

    if (this.model.focus === "stacks") {
      if (matchesKey(data, Key.escape) || data === "q") {
        this.callbacks.done({ changed: this.changed, outcome: this.lastOutcome });
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        this.model.moveStack(1, this.bodyRows());
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.model.moveStack(-1, this.bodyRows());
        this.tui.requestRender();
        return;
      }
      if (data === " ") {
        if (this.model.toggleStack()) this.apply();
        return;
      }
      if (
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.right) ||
        matchesKey(data, Key.tab) ||
        data === "l"
      ) {
        this.model.setFocus("members");
        this.tui.requestRender();
        return;
      }
      if (data === "n") {
        this.openNewStackDialog();
        return;
      }
      if (data === "d") {
        this.openDeleteDialog();
        return;
      }
      return;
    }

    // members focus
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.tab) ||
      data === "h"
    ) {
      this.model.setFocus("stacks");
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.model.moveMember(1, memberRows, availableRows);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.model.moveMember(-1, memberRows, availableRows);
      this.tui.requestRender();
      return;
    }
    if (data === " ") {
      const change = this.model.toggleMembership();
      if (change === "blocked") {
        const stack = this.model.selectedStack;
        if (stack && this.model.isProjectStack(stack)) {
          this.callbacks.notify(
            `"${stack}" is defined in .pi/skill-stacks.json; edit it there`,
            "warning",
          );
        }
        return;
      }
      this.apply();
    }
  }

  render(width: number): string[] {
    const rows = this.bodyRows();
    const { leftW, rightW } = this.paneWidths(width);
    const { memberRows, availableRows } = this.sectionRows();
    const stack = this.model.selectedStack;

    const activeCount = [...this.discovered].filter((skill) => this.model.isActiveSkill(skill)).length;
    const total = this.discovered.size;
    const dirty = this.changed ? this.theme.fg("warning", " · reload pending") : "";
    const title = `skill stacks · ${this.model.stackCount} ${
      this.model.stackCount === 1 ? "stack" : "stacks"
    } · ${activeCount}/${total} skills active${dirty}`;
    const lines = [this.border(width, title, true)];

    const stackWin = this.model.stackWindow(rows);
    const memberWin = this.model.memberWindow(memberRows);
    const availWin = this.model.availableWindow(availableRows);

    for (let row = 0; row < rows; row += 1) {
      const stackEntry = stackWin.items[row];
      const left = stackEntry
        ? this.renderStackCell(stackEntry.name, stackWin.start + row, leftW)
        : " ".repeat(leftW);

      let right: string;
      if (!stack) {
        right = padToWidth(this.theme.fg("dim", " no stacks"), rightW);
      } else if (row === 0) {
        right = this.renderStackHeader(stack, rightW);
      } else if (row === 1) {
        right = padToWidth(this.theme.fg("dim", " members"), rightW);
      } else if (row < 2 + memberRows) {
        const entry = memberWin.items[row - 2];
        right = entry
          ? this.renderMemberCell(entry.name, memberWin.start + (row - 2), rightW)
          : row - 2 === 0
            ? padToWidth(this.theme.fg("dim", " (none — space a skill below to add)"), rightW)
            : "";
      } else if (row === 2 + memberRows) {
        const available = this.model.availableFor(stack);
        right = padToWidth(this.theme.fg("dim", ` available · ${available.length}`), rightW);
      } else {
        const entry = availWin.items[row - 3 - memberRows];
        right = entry
          ? this.renderAvailableCell(entry.name, entry.otherStacks, availWin.start + (row - 3 - memberRows), rightW)
          : row - 3 - memberRows === 0
            ? padToWidth(this.theme.fg("dim", " (every discovered skill is in this stack)"), rightW)
            : "";
      }

      const mid = this.theme.fg(this.model.focus === "members" ? "borderAccent" : "borderMuted", "│");
      lines.push(
        `${this.theme.fg("borderMuted", "│")}${left}${mid}${right}${this.theme.fg("borderMuted", "│")}`,
      );
    }

    const help =
      this.model.focus === "stacks"
        ? "↑↓ select · space on/off · →/tab members · n new stack · d delete · esc done"
        : "↑↓ move · space add/remove · ←/tab back · esc back";
    lines.push(this.border(width, help, false));
    return lines;
  }

  // ---- internals ----

  private apply(): void {
    const snapshot = this.model.snapshot();
    this.lastOutcome = this.callbacks.persist(snapshot.stacks, snapshot.disabledStacks);
    this.changed = true;
    this.tui.requestRender();
  }

  private openNewStackDialog(): void {
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    void this.callbacks.input("New stack name", "e.g. writing").then((name) => {
      this.dialogOpen = false;
      const trimmed = name?.trim();
      if (!trimmed) return;
      if (!this.model.createStack(trimmed)) {
        this.callbacks.notify(`Stack "${trimmed}" already exists`, "warning");
        return;
      }
      this.apply();
    });
  }

  private openDeleteDialog(): void {
    const name = this.model.selectedStack;
    if (!name) return;
    if (this.model.isProjectStack(name)) {
      this.callbacks.notify(`"${name}" is defined in .pi/skill-stacks.json; edit it there`, "warning");
      return;
    }
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    const count = this.model.membersOf(name).length;
    void this.callbacks
      .confirm("Delete stack", `Remove "${name}" and its ${count} skill assignments?`)
      .then((confirmed) => {
        this.dialogOpen = false;
        if (!confirmed) return;
        if (this.model.deleteSelectedStack() === "deleted") this.apply();
      });
  }

  private bodyRows(): number {
    return Math.max(8, Math.floor(this.tui.terminal.rows * 0.8) - 2);
  }

  /** Right-pane layout: 1 stack header + members section + available section. */
  private sectionRows(): { memberRows: number; availableRows: number } {
    const content = Math.max(2, this.bodyRows() - 1 - 2);
    const memberRows = Math.max(1, Math.ceil(content / 2));
    return { memberRows, availableRows: Math.max(1, content - memberRows) };
  }

  private paneWidths(width: number): { leftW: number; rightW: number } {
    const leftW = Math.min(30, Math.max(18, Math.floor(width * 0.3)));
    return { leftW, rightW: Math.max(1, width - leftW - 3) };
  }

  private border(width: number, label: string, top: boolean): string {
    const left = top ? "┌" : "└";
    const right = top ? "┐" : "┘";
    const text = `─ ${label} `;
    const remaining = Math.max(0, width - visibleWidth(text) - 2);
    return this.theme.fg(
      "borderAccent",
      truncateToWidth(`${left}${text}${"─".repeat(remaining)}${right}`, width, ""),
    );
  }

  private renderStackHeader(stack: string, width: number): string {
    const enabled = !this.model.isDisabled(stack);
    const members = this.model.membersOf(stack);
    const found = members.filter((skill) => this.discovered.has(skill)).length;
    const header = ` ${stack} · ${found}/${members.length} skills${enabled ? "" : " · off"}${
      this.model.isProjectStack(stack) ? " · project-defined" : ""
    }`;
    return padToWidth(this.theme.fg(enabled ? "accent" : "muted", this.theme.bold(header)), width);
  }

  private renderStackCell(name: string, index: number, leftW: number): string {
    const enabled = !this.model.isDisabled(name);
    const selected = index === this.model.stackIndex;
    const cursor = selected && this.model.focus === "stacks" ? "› " : "  ";
    const box = enabled ? "[x]" : "[ ]";
    const members = this.model.membersOf(name);
    const found = members.filter((skill) => this.discovered.has(skill)).length;
    const total = members.length;
    const count = found === total ? `${total}` : `${found}/${total}`;
    const project = this.model.isProjectStack(name) ? this.theme.fg("dim", " ·proj") : "";

    const nameWidth = Math.max(1, leftW - 2 - 3 - 1 - count.length - 2);
    const shown = truncateToWidth(name, nameWidth, "…");
    const label =
      cursor +
      this.theme.fg(enabled ? "text" : "muted", box) +
      " " +
      (selected && this.model.focus === "stacks"
        ? this.theme.fg("accent", shown)
        : this.theme.fg(enabled ? "text" : "muted", shown)) +
      project;
    const gap = Math.max(1, leftW - visibleWidth(label) - count.length);
    const row = padToWidth(`${label}${" ".repeat(gap)}${this.theme.fg("dim", count)}`, leftW);
    if (!selected) return row;
    return this.theme.bg(this.model.focus === "stacks" ? "selectedBg" : "customMessageBg", row);
  }

  private renderMemberCell(name: string, index: number, width: number): string {
    const selected = index === this.model.memberIndex;
    const cursor = selected && this.model.focus === "members" ? "› " : "  ";
    const missing = !this.discovered.has(name);
    const active = this.model.isActiveSkill(name);
    const suffix = missing
      ? this.theme.fg("warning", " missing")
      : active
        ? ""
        : this.theme.fg("dim", " · excluded");
    const suffixWidth = missing ? 8 : active ? 0 : 11;
    const shown = truncateToWidth(name, Math.max(1, width - 2 - 3 - 1 - suffixWidth), "…");
    const label =
      cursor +
      "[x]" +
      " " +
      this.theme.fg(missing ? "warning" : active ? "text" : "muted", shown) +
      suffix;
    const row = padToWidth(label, width);
    if (!selected) return row;
    return this.theme.bg(this.model.focus === "members" ? "selectedBg" : "customMessageBg", row);
  }

  private renderAvailableCell(
    name: string,
    others: string[],
    index: number,
    width: number,
  ): string {
    const selected = index === this.model.memberIndex;
    const cursor = selected && this.model.focus === "members" ? "› " : "  ";
    const suffix = others.length > 0 ? this.theme.fg("dim", ` · ${others.join(", ")}`) : "";
    const suffixWidth = others.length > 0 ? 3 + others.join(", ").length : 0;
    const shown = truncateToWidth(name, Math.max(1, width - 2 - 3 - 1 - suffixWidth), "…");
    const row = padToWidth(`${cursor}[ ] ${this.theme.fg("muted", shown)}${suffix}`, width);
    if (!selected) return row;
    return this.theme.bg(this.model.focus === "members" ? "selectedBg" : "customMessageBg", row);
  }
}

function padToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export async function showStacksOverlay(
  ctx: ExtensionCommandContext,
  init: InitWithDiscovered,
  persist: StacksPersist,
): Promise<{ changed: boolean; outcome: ApplyOutcome | null }> {
  if (ctx.mode !== "tui") return { changed: false, outcome: null };

  return await ctx.ui.custom<{ changed: boolean; outcome: ApplyOutcome | null }>(
    (tui, theme, _kb, done) =>
      new StacksOverlay(tui, theme, init, {
        persist,
        notify: (message, type) => ctx.ui.notify(message, type),
        input: (title, placeholder) => ctx.ui.input(title, placeholder),
        confirm: (title, message) => ctx.ui.confirm(title, message),
        done,
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        minWidth: 76,
        maxHeight: "90%",
        margin: 1,
      },
    },
  );
}
