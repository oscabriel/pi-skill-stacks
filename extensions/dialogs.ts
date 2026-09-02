// Small dialogs the /stacks overlay opens on top of itself. pi's own
// ctx.ui.input/confirm render in the main layout, underneath any visible
// overlay, so these are overlays in their own right: opened with
// ctx.ui.custom({ overlay: true }) they stack above /stacks, take focus while
// open, and hand it back when done.

import { type Component, type Focusable, Input, Key, matchesKey } from "@earendil-works/pi-tui";
import { frameEdge, frameInnerWidth, frameRow, type OverlayTheme } from "./frame.ts";

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
