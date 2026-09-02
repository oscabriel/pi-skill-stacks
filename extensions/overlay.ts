// Two-pane overlay for /stacks: stacks on the left (on/off, create, delete,
// `a` to add unstacked skills), the selected stack's members on the right
// (space removes one). Every mutation is persisted immediately
// through the caller's callback; the ctx.reload() that makes pi pick the
// changes up happens once, after the overlay closes, and only if settings.json
// actually changed (re-stacking alone doesn't need one).
//
// StacksOverlay is a plain component (render/handleInput/invalidate) so it can
// be smoke-tested without a live pi session; showStacksOverlay wires it into
// the TUI.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type OverlayOptions,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { ConfirmDialog, PickDialog, PromptDialog } from "./dialogs.ts";
import { frameEdge, type OverlayTheme, padToWidth } from "./frame.ts";
import type { StackMap, StacksSummary } from "../src/core.ts";
import {
  StacksOverlayModel,
  type MemberRow,
  type StackRow,
  type StacksOverlayInit,
} from "../src/overlay-model.ts";

export interface ApplyOutcome {
  summary: StacksSummary;
  /** True when settings.json was rewritten, i.e. pi needs a reload to notice. */
  settingsChanged: boolean;
}

export interface OverlayResult {
  /** Any mutation happened while the overlay was open. */
  changed: boolean;
  /** Some mutation rewrote settings.json; the caller should ctx.reload(). */
  settingsDirty: boolean;
  outcome: ApplyOutcome | null;
}

export type StacksPersist = (stacks: StackMap, disabledStacks: string[]) => ApplyOutcome;

export type Notify = (message: string, type?: "info" | "warning" | "error") => void;

export interface StacksOverlayCallbacks {
  persist: StacksPersist;
  notify: Notify;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm: (title: string, message: string) => Promise<boolean>;
  /** Multi-select from `items`; undefined when cancelled. */
  pick: (title: string, items: readonly string[]) => Promise<string[] | undefined>;
  done: (result: OverlayResult) => void;
}

export type { OverlayTheme } from "./frame.ts";

/** Minimal slice of pi-tui's TUI the overlay touches (kept small so tests can fake it). */
export interface OverlayTui {
  terminal: { rows: number };
  requestRender(): void;
}

const CURSOR = "› ";
const NO_CURSOR = "  ";
/** `cursor + "[x]" + " "` before a name in every cell. */
const CELL_PREFIX_WIDTH = CURSOR.length + 3 + 1;

const projectStackNotice = (stack: string) =>
  `"${stack}" is defined in .pi/skill-stacks.json; edit it there`;

export class StacksOverlay {
  private readonly model: StacksOverlayModel;
  private readonly tui: OverlayTui;
  private readonly theme: OverlayTheme;
  private readonly callbacks: StacksOverlayCallbacks;
  private changed = false;
  private settingsDirty = false;
  private lastOutcome: ApplyOutcome | null = null;
  private dialogOpen = false;

  constructor(
    tui: OverlayTui,
    theme: OverlayTheme,
    init: StacksOverlayInit,
    callbacks: StacksOverlayCallbacks,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;
    this.model = new StacksOverlayModel(init);
  }

  invalidate() {}

  handleInput(data: string) {
    if (this.dialogOpen) return; // a dialog owns the keyboard until its promise settles
    if (this.model.focus === "stacks") this.handleStacksInput(data);
    else this.handleMembersInput(data);
  }

  private handleStacksInput(data: string) {
    if (matchesKey(data, Key.escape) || data === "q") {
      this.callbacks.done({
        changed: this.changed,
        settingsDirty: this.settingsDirty,
        outcome: this.lastOutcome,
      });
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.model.moveStack(1, this.bodyRows());
      this.tui.requestRender();
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.model.moveStack(-1, this.bodyRows());
      this.tui.requestRender();
    } else if (data === " ") {
      if (this.model.toggleStack()) this.apply();
    } else if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.right) ||
      matchesKey(data, Key.tab) ||
      data === "l"
    ) {
      this.model.setFocus("members");
      this.model.moveMember(0, this.memberRows());
      this.tui.requestRender();
    } else if (data === "n") {
      this.openNewStackDialog();
    } else if (data === "d") {
      this.openDeleteDialog();
    } else if (data === "a") {
      this.openAddDialog();
    }
  }

  private handleMembersInput(data: string) {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.tab) ||
      data === "h"
    ) {
      this.model.setFocus("stacks");
      this.tui.requestRender();
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.model.moveMember(1, this.memberRows());
      this.tui.requestRender();
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.model.moveMember(-1, this.memberRows());
      this.tui.requestRender();
    } else if (data === "a") {
      this.openAddDialog();
    } else if (data === " ") {
      const change = this.model.removeMember();
      if (change !== "blocked") {
        this.apply();
      } else if (this.model.selectedStack && this.model.isProjectStack(this.model.selectedStack)) {
        this.callbacks.notify(projectStackNotice(this.model.selectedStack), "warning");
      }
    }
  }

  render(width: number) {
    const rows = this.bodyRows();
    const { leftW, rightW } = this.paneWidths(width);
    const stack = this.model.selectedStack;

    const dirty = this.settingsDirty ? this.theme.fg("warning", " · reload pending") : "";
    const title = `skill stacks · ${this.model.stackCount} ${
      this.model.stackCount === 1 ? "stack" : "stacks"
    } · ${this.model.activeSkillCount}/${this.model.discoveredCount} skills active${dirty}`;
    const lines = [this.border(width, title, true)];

    const stackWin = this.model.stackWindow(rows);
    const memberWin = this.model.memberWindow(this.memberRows());
    const blank = (w: number) => " ".repeat(w);
    const hint = (text: string, w: number) => padToWidth(this.theme.fg("dim", text), w);

    for (let row = 0; row < rows; row += 1) {
      const stackEntry = stackWin.items[row];
      const left = stackEntry
        ? this.renderStackCell(stackEntry, stackWin.start + row, leftW)
        : blank(leftW);

      let right: string;
      if (!stack) {
        right = row === 0 ? hint(" no stacks · n creates one", rightW) : blank(rightW);
      } else if (row === 0) {
        right = this.renderStackHeader(stack, rightW);
      } else if (row === 1) {
        right = hint(" members", rightW);
      } else {
        const index = row - 2;
        const entry = memberWin.items[index];
        right = entry
          ? this.renderMemberCell(entry, memberWin.start + index, rightW)
          : index === 0
            ? hint(" (none · a adds skills)", rightW)
            : blank(rightW);
      }

      const mid = this.theme.fg(this.model.focus === "members" ? "borderAccent" : "borderMuted", "│");
      const edge = this.theme.fg("borderAccent", "│");
      lines.push(`${edge}${left}${mid}${right}${edge}`);
    }

    const help =
      this.model.focus === "stacks"
        ? "↑↓ select · space on/off · →/tab members · a add skills · n new stack · d delete · esc close"
        : "↑↓ move · space remove · a add skills · ←/tab back";
    lines.push(this.border(width, help, false));
    return lines;
  }

  // ---- internals ----

  private apply() {
    const snapshot = this.model.snapshot();
    this.lastOutcome = this.callbacks.persist(snapshot.stacks, snapshot.disabledStacks);
    this.changed = true;
    this.settingsDirty ||= this.lastOutcome.settingsChanged;
    this.tui.requestRender();
  }

  /** Run a dialog; while it is open no overlay keys are handled, and a rejected dialog can't wedge the flag. */
  private async withDialog(run: () => Promise<void>) {
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    try {
      await run();
    } catch (error) {
      this.callbacks.notify(`skill-stacks: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      this.dialogOpen = false;
      this.tui.requestRender();
    }
  }

  private openNewStackDialog() {
    void this.withDialog(async () => {
      const name = (await this.callbacks.input("New stack name", "e.g. writing"))?.trim();
      if (!name) return;
      if (!this.model.createStack(name)) {
        this.callbacks.notify(`Stack "${name}" already exists`, "warning");
        return;
      }
      this.apply();
    });
  }

  private openDeleteDialog() {
    const name = this.model.selectedStack;
    if (!name) return;
    if (this.model.isProjectStack(name)) {
      this.callbacks.notify(projectStackNotice(name), "warning");
      return;
    }
    const count = this.model.membersOf(name).length;
    void this.withDialog(async () => {
      const confirmed = await this.callbacks.confirm(
        "Delete stack",
        `Remove "${name}" and its ${count} skill assignments?`,
      );
      if (confirmed && this.model.deleteSelectedStack() === "deleted") this.apply();
    });
  }

  /** `a`: pick from the skills no stack holds yet and add them to the selected stack. */
  private openAddDialog() {
    const name = this.model.selectedStack;
    if (!name) return;
    if (this.model.isProjectStack(name)) {
      this.callbacks.notify(projectStackNotice(name), "warning");
      return;
    }
    const unstacked = this.model.unstackedSkills();
    if (unstacked.length === 0) {
      this.callbacks.notify("Every discovered skill is already in a stack", "info");
      return;
    }
    void this.withDialog(async () => {
      const picked = await this.callbacks.pick(`Add to ${name} · ${unstacked.length} unstacked`, unstacked);
      if (picked && this.model.addSkills(picked) === "added") this.apply();
    });
  }

  private bodyRows() {
    return Math.max(8, Math.floor(this.tui.terminal.rows * 0.8) - 2);
  }

  /** Right pane: 1 stack header row + 1 "members" label row, then the list. */
  private memberRows() {
    return Math.max(1, this.bodyRows() - 2);
  }

  private paneWidths(width: number) {
    const leftW = Math.min(30, Math.max(18, Math.floor(width * 0.3)));
    return { leftW, rightW: Math.max(1, width - leftW - 3) };
  }

  private border(width: number, label: string, top: boolean) {
    return frameEdge(this.theme, width, label, top);
  }

  private renderStackHeader(stack: string, width: number) {
    const row = this.model.stackRow(stack);
    const header = ` ${stack} · ${row.found}/${row.total} skills${row.enabled ? "" : " · off"}${
      row.project ? " · project-defined" : ""
    }`;
    return padToWidth(this.theme.fg(row.enabled ? "accent" : "muted", this.theme.bold(header)), width);
  }

  private selectedBg(row: string, pane: "stacks" | "members") {
    return this.theme.bg(this.model.focus === pane ? "selectedBg" : "customMessageBg", row);
  }

  private renderStackCell(entry: StackRow, index: number, leftW: number) {
    const selected = index === this.model.stackIndex;
    const focused = selected && this.model.focus === "stacks";
    const count = entry.found === entry.total ? `${entry.total}` : `${entry.found}/${entry.total}`;
    const projectTag = entry.project ? " ·proj" : "";
    const tone = entry.enabled ? "text" : "muted";

    const nameWidth = Math.max(1, leftW - CELL_PREFIX_WIDTH - projectTag.length - count.length - 2);
    const shown = truncateToWidth(entry.name, nameWidth, "…");
    const label =
      (focused ? CURSOR : NO_CURSOR) +
      this.theme.fg(tone, entry.enabled ? "[x]" : "[ ]") +
      " " +
      this.theme.fg(focused ? "accent" : tone, shown) +
      this.theme.fg("dim", projectTag);
    const gap = Math.max(1, leftW - visibleWidth(label) - count.length);
    const row = padToWidth(`${label}${" ".repeat(gap)}${this.theme.fg("dim", count)}`, leftW);
    return selected ? this.selectedBg(row, "stacks") : row;
  }

  private renderMemberCell(entry: MemberRow, index: number, width: number) {
    const selected = index === this.model.memberIndex;
    const focused = selected && this.model.focus === "members";
    const suffixText = entry.missing ? " missing" : entry.active ? "" : " · excluded";
    const suffix = entry.missing
      ? this.theme.fg("warning", suffixText)
      : this.theme.fg("dim", suffixText);
    const nameWidth = Math.max(1, width - CELL_PREFIX_WIDTH - suffixText.length);
    const shown = truncateToWidth(entry.name, nameWidth, "…");
    const tone = entry.missing ? "warning" : entry.active ? "text" : "muted";
    const row = padToWidth(`${focused ? CURSOR : NO_CURSOR}[x] ${this.theme.fg(tone, shown)}${suffix}`, width);
    return selected ? this.selectedBg(row, "members") : row;
  }

}

export async function showStacksOverlay(
  ctx: ExtensionCommandContext,
  init: StacksOverlayInit,
  persist: StacksPersist,
): Promise<OverlayResult> {
  if (ctx.mode !== "tui") return { changed: false, settingsDirty: false, outcome: null };

  // pi's ctx.ui.input/confirm render in the main layout, underneath a visible
  // overlay. Our dialogs are overlays themselves so they stack on top of /stacks.
  const dialogOptions = {
    overlay: true,
    overlayOptions: { anchor: "center", width: 60, minWidth: 44 } satisfies OverlayOptions,
  };

  return await ctx.ui.custom<OverlayResult>(
    (tui, theme, _kb, done) =>
      new StacksOverlay(tui, theme, init, {
        persist,
        notify: (message, type) => ctx.ui.notify(message, type),
        input: (title, placeholder) =>
          ctx.ui.custom<string | undefined>(
            (_tui, theme, _kb, done) => new PromptDialog(theme, title, placeholder, done),
            dialogOptions,
          ),
        confirm: (title, message) =>
          ctx.ui.custom<boolean>(
            (_tui, theme, _kb, done) => new ConfirmDialog(theme, title, message, done),
            dialogOptions,
          ),
        pick: (title, items) =>
          ctx.ui.custom<string[] | undefined>(
            (_tui, theme, _kb, done) => new PickDialog(theme, title, items, done),
            dialogOptions,
          ),
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
