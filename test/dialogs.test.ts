import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ConfirmDialog, PromptDialog } from "../extensions/dialogs.ts";

const fakeTheme = {
  fg: (_color: string, text: string) => `\x1b[38;5;4m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[48;5;8m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function assertExactWidth(lines: string[], width: number, label: string) {
  for (const line of lines) {
    assert.equal(visibleWidth(line), width, `${label} width=${width}: ${JSON.stringify(line)}`);
  }
}

test("dialogs render every line at exactly the requested width", () => {
  for (const width of [8, 20, 44, 60, 120]) {
    const prompt = new PromptDialog(fakeTheme, "New stack name", "e.g. writing", () => {});
    assertExactWidth(prompt.render(width), width, "prompt empty");
    prompt.handleInput("a-name-long-enough-to-scroll-inside-a-narrow-input-box");
    assertExactWidth(prompt.render(width), width, "prompt filled");

    const confirm = new ConfirmDialog(fakeTheme, "Delete stack", 'Remove "x" and its 3 skill assignments?', () => {});
    assertExactWidth(confirm.render(width), width, "confirm");
  }
});

test("PromptDialog: typing shows in the input, enter resolves trimmed, escape resolves undefined", () => {
  const results: (string | undefined)[] = [];
  const prompt = new PromptDialog(fakeTheme, "New stack name", "e.g. writing", (v) => results.push(v));

  const before = prompt.render(60).map(stripAnsi).join("\n");
  assert.match(before, /e\.g\. writing/, "placeholder shows while empty");

  for (const ch of "  writing ") prompt.handleInput(ch);
  const after = prompt.render(60).map(stripAnsi).join("\n");
  assert.match(after, /> {3}writing/); // "> " prompt + the two leading spaces typed
  assert.doesNotMatch(after, /e\.g\. writing/, "placeholder hides once there is text");

  prompt.handleInput("\r");
  assert.deepEqual(results, ["writing"]);

  const cancelResults: (string | undefined)[] = [];
  const cancelled = new PromptDialog(fakeTheme, "t", undefined, (v) => cancelResults.push(v));
  cancelled.handleInput("\x1b");
  assert.deepEqual(cancelResults, [undefined]);
});

test("PromptDialog: focus propagates to the inner Input", () => {
  const prompt = new PromptDialog(fakeTheme, "t", undefined, () => {});
  prompt.focused = true;
  assert.equal(prompt.focused, true);
  // pi-tui's Input emits the hardware-cursor marker only when focused
  const focusedRender = prompt.render(60).join("");
  prompt.focused = false;
  const unfocusedRender = prompt.render(60).join("");
  assert.notEqual(focusedRender, unfocusedRender);
});

test("ConfirmDialog: enter confirms, esc cancels, other keys ignored", () => {
  const results: boolean[] = [];
  const make = () => new ConfirmDialog(fakeTheme, "t", "m", (v) => results.push(v));
  make().handleInput("\r");
  make().handleInput("\x1b");
  const ignored = make();
  for (const key of ["y", "n", "x", " "]) ignored.handleInput(key);
  assert.deepEqual(results, [true, false]);
});
