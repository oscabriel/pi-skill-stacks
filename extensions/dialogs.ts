// Small dialogs the /stacks overlay opens on top of itself. pi's own
// ctx.ui.input/confirm render in the main layout, underneath any visible
// overlay, so these are overlays in their own right: opened with
// ctx.ui.custom({ overlay: true }) they stack above /stacks, take focus while
// open, and hand it back when done.

import { type Component, type Focusable, Input, Key, matchesKey } from "@earendil-works/pi-tui";
import { frameEdge, frameInnerWidth, frameRow, type OverlayTheme, padToWidth } from "./frame.ts";

/** Single-line text prompt. Resolves with the trimmed value, or undefined on escape. */
export class PromptDialog implements Component, Focusable {
  private readonly input = new Input();
  private _focused = false;
  private readonly theme: OverlayTheme;
  private readonly title: string;
  private readonly placeholder: string | undefined;
  private readonly done: (value: string | undefined) => void;

  constructor(
    theme: OverlayTheme,
    title: string,
    placeholder: string | undefined,
    done: (value: string | undefined) => void,
  ) {
    this.theme = theme;
    this.title = title;
    this.placeholder = placeholder;
    this.done = done;
  }

  /** Propagate focus to the Input so it emits the hardware-cursor marker (IME placement). */
  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.enter) || data === "\n") {
      this.done(this.input.getValue().trim());
    } else if (matchesKey(data, Key.escape)) {
      this.done(undefined);
    } else {
      this.input.handleInput(data);
    }
  }

  invalidate() {}

  render(width: number) {
    const inner = frameInnerWidth(width);
    const [inputLine = ""] = this.input.render(inner);
    const showPlaceholder = this.placeholder && this.input.getValue() === "";
    return [
      frameEdge(this.theme, width, this.title, true),
      frameRow(this.theme, width, ""),
      frameRow(this.theme, width, inputLine),
      frameRow(this.theme, width, showPlaceholder ? this.theme.fg("dim", `  ${this.placeholder}`) : ""),
      frameEdge(this.theme, width, "enter confirm · esc cancel", false),
    ];
  }
}

/** Yes/no confirmation. Resolves true on enter, false on escape. */
export class ConfirmDialog implements Component {
  private readonly theme: OverlayTheme;
  private readonly title: string;
  private readonly message: string;
  private readonly done: (confirmed: boolean) => void;

  constructor(theme: OverlayTheme, title: string, message: string, done: (confirmed: boolean) => void) {
    this.theme = theme;
    this.title = title;
    this.message = message;
    this.done = done;
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.enter) || data === "\n") {
      this.done(true);
    } else if (matchesKey(data, Key.escape)) {
      this.done(false);
    }
  }

  invalidate() {}

  render(width: number) {
    return [
      frameEdge(this.theme, width, this.title, true),
      frameRow(this.theme, width, ""),
      frameRow(this.theme, width, this.theme.fg("text", this.message)),
      frameRow(this.theme, width, ""),
      frameEdge(this.theme, width, "enter confirm · esc cancel", false),
    ];
  }
}

/**
 * Pick one or more skills from a list. `space` marks, `enter` resolves with the
 * marked set (or just the highlighted skill when nothing is marked), `esc`
 * resolves undefined.
 */
export class PickDialog implements Component {
  static readonly MAX_ROWS = 16;

  private readonly theme: OverlayTheme;
  private readonly title: string;
  private readonly items: readonly string[];
  private readonly done: (picked: string[] | undefined) => void;
  private readonly marked = new Set<string>();
  private cursor = 0;
  private offset = 0;

  constructor(
    theme: OverlayTheme,
    title: string,
    items: readonly string[],
    done: (picked: string[] | undefined) => void,
  ) {
    this.theme = theme;
    this.title = title;
    this.items = items;
    this.done = done;
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.enter) || data === "\n") {
      const highlighted = this.items[this.cursor];
      const picked = this.marked.size > 0 ? this.items.filter((s) => this.marked.has(s)) : highlighted ? [highlighted] : [];
      this.done(picked);
    } else if (matchesKey(data, Key.escape)) {
      this.done(undefined);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.move(1);
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.move(-1);
    } else if (data === " ") {
      const skill = this.items[this.cursor];
      if (!skill) return;
      if (this.marked.has(skill)) this.marked.delete(skill);
      else this.marked.add(skill);
    }
  }

  invalidate() {}

  render(width: number) {
    const rows = this.visibleRows();
    const lines = [frameEdge(this.theme, width, this.title, true)];
    for (let row = 0; row < rows; row += 1) {
      const index = this.offset + row;
      const skill = this.items[index];
      lines.push(frameRow(this.theme, width, skill ? this.cell(skill, index, frameInnerWidth(width)) : ""));
    }
    const marked = this.marked.size > 0 ? ` · ${this.marked.size} marked` : "";
    lines.push(frameEdge(this.theme, width, `↑↓ move · space mark · enter add${marked} · esc cancel`, false));
    return lines;
  }

  private visibleRows() {
    return Math.max(1, Math.min(PickDialog.MAX_ROWS, this.items.length));
  }

  private move(delta: number) {
    if (this.items.length === 0) return;
    this.cursor = Math.max(0, Math.min(this.items.length - 1, this.cursor + delta));
    const rows = this.visibleRows();
    if (this.cursor < this.offset) this.offset = this.cursor;
    else if (this.cursor >= this.offset + rows) this.offset = this.cursor - rows + 1;
  }

  private cell(skill: string, index: number, width: number) {
    const selected = index === this.cursor;
    const box = this.marked.has(skill) ? "[x]" : "[ ]";
    const text = padToWidth(`${selected ? "› " : "  "}${box} ${skill}`, width);
    return selected ? this.theme.bg("selectedBg", this.theme.fg("accent", text)) : this.theme.fg("text", text);
  }
}
