// Two-pane overlay for /stacks: stacks on the left (on/off, create, delete,
// `a` to add unstacked skills), the selected stack's members on the right
// (space removes one, enter opens a skill viewer as a third pane inside the
// overlay). Every mutation is persisted immediately
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

/**
 * Wheel direction from a terminal mouse report: -1 up, +1 down, 0 not a wheel
 * event. Matches pi-tui's parseWheelEvent — in fullscreen mode pi captures the
 * mouse and, while an overlay is focused, wheel reports fall through to
 * handleInput instead of scrolling the transcript.
 */
function wheelDirection(data: string): -1 | 0 | 1 {
  const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (!sgr && !(data.length === 6 && data.startsWith("\x1b[M"))) return 0;
  const button = sgr ? Number(sgr[1]) : data.charCodeAt(3) - 32;
  if ((button & 64) === 0) return 0;
  const direction = button & 3;
  return direction === 0 ? -1 : direction === 1 ? 1 : 0;
}

export class StacksOverlay {
  private readonly model: StacksOverlayModel;
  private readonly tui: OverlayTui;
  private readonly theme: OverlayTheme;
  private readonly callbacks: StacksOverlayCallbacks;
  private changed = false;
  private settingsDirty = false;
  private lastOutcome: ApplyOutcome | null = null;
  private dialogOpen = false;
  /** Width of the last render; handleInput uses it for the viewer's wrap width. */
  private lastWidth = 80;

  constructor(
    tui: OverlayTui,
    theme: OverlayTheme,
    init: StacksOverlayInit,
    callbacks: StacksOverlayCallbacks,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;
    this.model = new StacksOverlayModel({ ...init, styler: theme });
  }

  invalidate() {}

  handleInput(data: string) {
    if (this.dialogOpen) return; // a dialog owns the keyboard until its promise settles
    if (this.model.focus === "stacks") this.handleStacksInput(data);
    else if (this.model.focus === "viewer") this.handleViewerInput(data);
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
    // consistent pane navigation: ←/esc always back, →/tab always forward
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "h") {
      this.model.setFocus("stacks");
      this.tui.requestRender();
    } else if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.right) ||
      matchesKey(data, Key.tab)
    ) {
      // enter opens the skill viewer pane to the right (focus moves with it)
      if (this.model.openViewer()) {
        this.tui.requestRender();
      } else if (this.model.selectedMember) {
        this.callbacks.notify(`"${this.model.selectedMember}" is not on disk`, "warning");
      }
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.model.moveMember(1, this.memberRows());
      this.tui.requestRender();
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.model.moveMember(-1, this.memberRows());
      this.tui.requestRender();
    } else if (matchesKey(data, Key.enter)) {
      // enter opens the skill viewer pane to the right (focus moves with it)
      if (this.model.openViewer()) {
        this.tui.requestRender();
      } else if (this.model.selectedMember) {
        this.callbacks.notify(`"${this.model.selectedMember}" is not on disk`, "warning");
      }
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

  private handleViewerInput(data: string) {
    const wheel = wheelDirection(data);
    if (wheel !== 0) {
      this.model.moveViewer(wheel, this.viewerTextWidth(), this.viewerRows());
      this.tui.requestRender();
      return;
    }
    // ←/esc (and enter) return to members; →/tab are no-ops, the viewer is the last pane
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.left) ||
      data === "h"
    ) {
      this.model.closeViewer();
      this.tui.requestRender();
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.model.moveViewer(1, this.viewerTextWidth(), this.viewerRows());
      this.tui.requestRender();
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.model.moveViewer(-1, this.viewerTextWidth(), this.viewerRows());
      this.tui.requestRender();
    }
  }

  render(width: number) {
    this.lastWidth = width;
    const rows = this.bodyRows();
    const { leftW, membersW, viewerW } = this.paneWidths(width);
    const stack = this.model.selectedStack;

    const dirty = this.settingsDirty ? this.theme.fg("warning", " · reload pending") : "";
    const title = `skill stacks (${this.model.stackCount}) · ${
      this.model.activeSkillCount
    }/${this.model.discoveredCount} active${dirty}`;
    const lines = [this.border(width, title, true)];

    const stackWin = this.model.stackWindow(rows);
    const memberWin = this.model.memberWindow(this.memberRows());
    const viewerWin = this.model.viewerOpen
      ? this.model.viewerWindow(Math.max(1, viewerW - 2), this.viewerRows())
      : undefined;
    const blank = (w: number) => " ".repeat(w);
    const hint = (text: string, w: number) => padToWidth(this.theme.fg("dim", text), w);

    for (let row = 0; row < rows; row += 1) {
      const stackEntry = stackWin.items[row];
      const left = stackEntry
        ? this.renderStackCell(stackEntry, stackWin.start + row, leftW)
        : blank(leftW);

      let members: string;
      if (!stack) {
        members = row === 0 ? hint(" no stacks · n creates one", membersW) : blank(membersW);
      } else if (row === 0) {
        members = this.renderStackHeader(stack, membersW);
      } else if (row === 1) {
        members = hint(" members", membersW);
      } else {
        const index = row - 2;
        const entry = memberWin.items[index];
        members = entry
          ? this.renderMemberCell(entry, memberWin.start + index, membersW)
          : index === 0
            ? hint(" (none · a adds skills)", membersW)
            : blank(membersW);
      }

      let viewer = blank(viewerW);
      if (viewerWin) {
        if (row === 0) {
          viewer = this.renderViewerHeader(viewerW);
        } else if (viewerWin.items.length === 0 && row === 1) {
          viewer = hint(" (no content)", viewerW);
        } else {
          const entry = viewerWin.items[row - 1];
          if (entry !== undefined) viewer = padToWidth(this.theme.fg("text", ` ${entry}`), viewerW);
        }
      }

      const mid = this.theme.fg(this.model.focus === "members" ? "borderAccent" : "borderMuted", "│");
      const viewerSep = viewerWin
        ? this.theme.fg(this.model.focus === "viewer" ? "borderAccent" : "borderMuted", "│")
        : "";
      const edge = this.theme.fg("borderAccent", "│");
      lines.push(`${edge}${left}${mid}${members}${viewerSep}${viewer}${edge}`);
    }

    const help = this.model.viewerOpen
      ? this.hintBar([
          ["↑↓", "scroll"],
          ["esc", "back"],
        ])
      : this.model.focus === "stacks"
        ? this.hintBar([
            ["↑↓", "select"],
            ["space", "on/off"],
            ["→/tab", "members"],
            ["a", "add skills"],
            ["n", "new stack"],
            ["d", "delete"],
            ["esc", "close"],
          ])
        : this.hintBar([
            ["↑↓", "move"],
            ["space", "remove"],
            ["enter", "view"],
            ["a", "add skills"],
            ["←/esc", "back"],
          ]);
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

  /** Viewer pane: 1 skill-name header row, then the wrapped markdown. */
  private viewerRows() {
    return Math.max(1, this.bodyRows() - 1);
  }

  private viewerTextWidth() {
    return Math.max(1, this.paneWidths(this.lastWidth).viewerW - 2);
  }

  private paneWidths(width: number) {
    const leftW = Math.min(30, Math.max(18, Math.floor(width * 0.3)));
    if (!this.model.viewerOpen) {
      return { leftW, membersW: Math.max(1, width - leftW - 3), viewerW: 0 };
    }
    // edge + left + │ + members + │ + viewer + edge = width (four vertical bars)
    const remaining = Math.max(0, width - leftW - 4);
    const viewerW = Math.max(10, Math.floor(remaining * 0.6));
    const membersW = Math.max(1, remaining - viewerW);
    return { leftW, membersW, viewerW };
  }

  private border(width: number, label: string, top: boolean) {
    return frameEdge(this.theme, width, label, top);
  }

  /** ` [↑↓] select · [space] on/off`: bracketed keys in plain text, labels dim. */
  private hintBar(parts: Array<readonly [string, string]>) {
    const sep = this.theme.fg("dim", " · ");
    return parts
      .map(([key, label]) => `${this.theme.fg("text", `[${key}]`)} ${this.theme.fg("dim", label)}`)
      .join(sep);
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

  private renderViewerHeader(viewerW: number) {
    const name = this.model.selectedMember ?? "";
    return padToWidth(this.theme.fg("accent", this.theme.bold(` ${name}`)), viewerW);
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
