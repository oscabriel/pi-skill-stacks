import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ConfirmDialog, PickDialog, PromptDialog } from "../extensions/dialogs.ts";

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

const items = Array.from({ length: 30 }, (_, i) => `skill-${String(i).padStart(2, "0")}`);

test("PickDialog renders every line at exactly the requested width, at any list length", () => {
  for (const width of [8, 20, 44, 60, 120]) {
    for (const count of [1, 5, 30]) {
      const pick = new PickDialog(fakeTheme, "Add to writing", items.slice(0, count), () => {});
      assertExactWidth(pick.render(width), width, `pick n=${count}`);
      pick.handleInput(" ");
      pick.handleInput("\x1b[B");
      assertExactWidth(pick.render(width), width, `pick marked n=${count}`);
    }
  }
});

test("PickDialog: caps visible rows and scrolls the cursor into view", () => {
  const pick = new PickDialog(fakeTheme, "Add", items, () => {});
  const first = pick.render(60).map(stripAnsi);
  assert.equal(first.length, PickDialog.MAX_ROWS + 3, "filter row, list rows, two frame edges");
  assert.match(first.join("\n"), /› \[ \] skill-00/);
  for (let i = 0; i < 20; i += 1) pick.handleInput("\x1b[B");
  const later = pick.render(60).map(stripAnsi).join("\n");
  assert.match(later, /› \[ \] skill-20/);
  assert.doesNotMatch(later, /skill-00/);
});

test("PickDialog: enter with nothing marked adds the highlighted skill", () => {
  const results: (string[] | undefined)[] = [];
  const pick = new PickDialog(fakeTheme, "Add", items.slice(0, 5), (v) => results.push(v));
  pick.handleInput("\x1b[B");
  pick.handleInput("\x1b[B");
  pick.handleInput("\r");
  assert.deepEqual(results, [["skill-02"]]);
});

test("PickDialog: space marks and unmarks, enter adds the marked set, esc cancels", () => {
  const results: (string[] | undefined)[] = [];
  const pick = new PickDialog(fakeTheme, "Add", items.slice(0, 5), (v) => results.push(v));
  pick.handleInput(" "); // mark 00
  pick.handleInput("\x1b[B");
  pick.handleInput(" "); // mark 01
  pick.handleInput(" "); // unmark 01
  pick.handleInput("\x1b[B");
  pick.handleInput(" "); // mark 02
  assert.match(pick.render(60).map(stripAnsi).join("\n"), /2 marked/);
  pick.handleInput("\r");
  assert.deepEqual(results, [["skill-00", "skill-02"]]);

  const cancelResults: (string[] | undefined)[] = [];
  const cancelled = new PickDialog(fakeTheme, "Add", items.slice(0, 5), (v) => cancelResults.push(v));
  cancelled.handleInput(" ");
  cancelled.handleInput("\x1b");
  assert.deepEqual(cancelResults, [undefined]);
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

test("PickDialog: typing filters the list and shows the match count", () => {
  const pick = new PickDialog(fakeTheme, "Add", items, () => {});
  pick.handleInput("0"); // filters to skill-00…09, skill-10, skill-20
  const filtered = pick.render(60).map(stripAnsi).join("\n");
  assert.match(filtered, /12\/30/);
  assert.match(filtered, /› \[ \] skill-00/);
  assert.doesNotMatch(filtered, /skill-29/);
  // backspace clears the filter
  pick.handleInput("\x7f");
  assert.match(pick.render(60).map(stripAnsi).join("\n"), /type to filter/);
  assert.match(pick.render(60).map(stripAnsi).join("\n"), /› \[ \] skill-00/);
});

test("PickDialog: filter is case-insensitive and cursor stays clamped while filtering", () => {
  const results: (string[] | undefined)[] = [];
  const pick = new PickDialog(fakeTheme, "Add", items, (v) => results.push(v));
  for (let i = 0; i < 10; i += 1) pick.handleInput("\x1b[B"); // cursor deep in the list
  pick.handleInput("S"); // uppercase still matches, cursor clamps back into range
  pick.handleInput("KILL-29");
  const rendered = pick.render(60).map(stripAnsi).join("\n");
  assert.match(rendered, /1\/30/);
  assert.match(rendered, /› \[ \] skill-29/);
  pick.handleInput("\r");
  assert.deepEqual(results, [["skill-29"]]);
});

test("PickDialog: enter adds marks that the current filter hides", () => {
  const results: (string[] | undefined)[] = [];
  const pick = new PickDialog(fakeTheme, "Add", items, (v) => results.push(v));
  pick.handleInput(" "); // mark skill-00
  pick.handleInput("1"); // filter away skill-00
  pick.handleInput("\r");
  assert.deepEqual(results, [["skill-00"]]);
});

test("PickDialog: enter with no matches resolves an empty set", () => {
  const results: (string[] | undefined)[] = [];
  const pick = new PickDialog(fakeTheme, "Add", items.slice(0, 5), (v) => results.push(v));
  pick.handleInput("zzz");
  pick.handleInput("\r");
  assert.deepEqual(results, [[]]);
});
