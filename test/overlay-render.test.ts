import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { StacksSummary } from "../src/core.ts";
import { StacksOverlay, type ApplyOutcome, type OverlayResult } from "../extensions/overlay.ts";
import { skillsOnDisk } from "./helpers.ts";

// Regression guard for the width-cache crash class: every rendered line must
// fit the width the TUI passes in, at any terminal size. Lines must also be
// exactly that wide so the right border stays a straight column.

const fakeTheme = {
  fg: (_color: string, text: string) => `\x1b[38;5;4m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[48;5;8m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

const emptySummary: StacksSummary = {
  stackCount: 0,
  offStacks: [],
  totalCount: 0,
  activeCount: 0,
  stacks: [],
};

const outcome = (settingsChanged: boolean): ApplyOutcome => ({ summary: emptySummary, settingsChanged });

const sampleStacks = {
  matt: Array.from({ length: 28 }, (_, i) => `skill-${i}`),
  firecrawl: ["firecrawl-scrape", "ghost-skill", "an-extremely-long-skill-directory-name-here"],
  remotion: [],
  "a-very-long-stack-name-that-needs-truncation": ["alpha"],
};

function makeOverlay(
  rows: number,
  overrides?: { stacks?: Record<string, string[]>; settingsChanged?: boolean },
) {
  const results: OverlayResult[] = [];
  const overlay = new StacksOverlay(
    { terminal: { rows }, requestRender: () => {} },
    fakeTheme,
    {
      stacks: overrides?.stacks ?? sampleStacks,
      disabledStacks: ["remotion"],
      discovered: skillsOnDisk("skill-0", "firecrawl-scrape", "alpha", "beta"),
      projectStackNames: new Set(["remotion"]),
    },
    {
      persist: () => outcome(overrides?.settingsChanged ?? false),
      notify: () => {},
      input: async () => undefined,
      confirm: async () => false,
      pick: async () => undefined,
      done: (result) => results.push(result),
    },
  );
  return { overlay, results };
}

function assertFramesFit(overlay: StacksOverlay, width: number, label: string) {
  for (const line of overlay.render(width)) {
    assert.equal(
      visibleWidth(line),
      width,
      `${label} width=${width}: line is ${visibleWidth(line)} wide: ${JSON.stringify(line)}`,
    );
  }
}

test("render: every line is exactly the width, across sizes, panes, focus, and empty state", () => {
  for (const rows of [10, 24, 40, 80]) {
    for (const width of [40, 50, 76, 100, 160, 200, 300]) {
      const { overlay } = makeOverlay(rows);
      assertFramesFit(overlay, width, `rows=${rows}`);
      overlay.handleInput("\t"); // members focus renders the other pane layout
      assertFramesFit(overlay, width, `members focus rows=${rows}`);

      const empty = makeOverlay(rows, { stacks: {} }).overlay;
      assertFramesFit(empty, width, `no stacks rows=${rows}`);
    }
  }
});

test("render: every row count matches the requested body height", () => {
  for (const rows of [10, 24, 40]) {
    const { overlay } = makeOverlay(rows);
    const expected = Math.max(8, Math.floor(rows * 0.8) - 2) + 2; // body + borders
    assert.equal(overlay.render(100).length, expected);
  }
});

test("render: empty state points at the create key", () => {
  const { overlay } = makeOverlay(24, { stacks: {} });
  assert.match(overlay.render(100).join("\n"), /no stacks · n creates one/);
});

test("render: exactly one cursor and one highlighted row in the right pane", () => {
  const { overlay } = makeOverlay(40, {
    stacks: { one: ["alpha", "beta", "gamma"] },
  });
  overlay.handleInput("\t"); // members focus
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const cursorRows = (lines: string[]) =>
    lines.map(stripAnsi).filter((line) => /│\s*› /.test(line.slice(line.indexOf("│") + 1)));
  // one highlighted row per pane: the selected stack on the left, the cursor row on the right
  const highlighted = (lines: string[]) => lines.join("").split("\x1b[48;5;8m").length - 1;

  overlay.handleInput("j");
  let lines = overlay.render(100);
  let cursors = cursorRows(lines);
  assert.equal(cursors.length, 1, cursors.join("\n"));
  assert.match(cursors[0]!, /\[x\] beta/);
  assert.equal(highlighted(lines), 2);

  // past the end: clamps on the last member, still one cursor
  overlay.handleInput("j");
  overlay.handleInput("j");
  lines = overlay.render(100);
  cursors = cursorRows(lines);
  assert.equal(cursors.length, 1, cursors.join("\n"));
  assert.match(cursors[0]!, /\[x\] gamma/);
  assert.equal(highlighted(lines), 2);
});

test("handleInput: a toggle that rewrote settings shows reload pending", () => {
  const { overlay } = makeOverlay(40, { settingsChanged: true });
  overlay.handleInput(" ");
  assert.match(overlay.render(100).join("\n"), /reload pending/);
});

test("handleInput: a change that left settings alone does not ask for a reload", () => {
  const { overlay, results } = makeOverlay(40, { settingsChanged: false });
  overlay.handleInput(" ");
  assert.doesNotMatch(overlay.render(100).join("\n"), /reload pending/);
  overlay.handleInput("\x1b");
  assert.deepEqual(results, [{ changed: true, settingsDirty: false, outcome: outcome(false) }]);
});

test("handleInput: settingsDirty sticks once any mutation changed settings", () => {
  let changed = true;
  const results: OverlayResult[] = [];
  const overlay = new StacksOverlay(
    { terminal: { rows: 40 }, requestRender: () => {} },
    fakeTheme,
    { stacks: { one: ["alpha"], two: ["beta"] }, disabledStacks: [], discovered: skillsOnDisk("alpha", "beta") },
    {
      persist: () => outcome(changed),
      notify: () => {},
      input: async () => undefined,
      confirm: async () => false,
      pick: async () => undefined,
      done: (result) => results.push(result),
    },
  );
  overlay.handleInput(" "); // settings changed
  changed = false;
  overlay.handleInput("j");
  overlay.handleInput(" "); // this one didn't
  overlay.handleInput("q");
  assert.equal(results[0]?.settingsDirty, true);
  assert.equal(results[0]?.changed, true);
});

test("handleInput: a rejected dialog reports the error and frees the keyboard", async () => {
  const notices: string[] = [];
  const overlay = new StacksOverlay(
    { terminal: { rows: 40 }, requestRender: () => {} },
    fakeTheme,
    { stacks: { one: ["alpha"] }, disabledStacks: [], discovered: skillsOnDisk("alpha") },
    {
      persist: () => outcome(false),
      notify: (message) => notices.push(message),
      input: async () => {
        throw new Error("dialog exploded");
      },
      confirm: async () => false,
      pick: async () => undefined,
      done: () => {},
    },
  );
  overlay.handleInput("n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(notices.join("\n"), /dialog exploded/);
  overlay.handleInput(" "); // would be swallowed if dialogOpen were stuck
  assert.match(overlay.render(100).join("\n"), /\[ \]/);
});

test("handleInput: `a` offers only unstacked skills and adds what was picked", async () => {
  const offered: (readonly string[])[] = [];
  const notices: string[] = [];
  let persisted: Record<string, string[]> | undefined;
  const make = (stacks: Record<string, string[]>, discovered: string[], projectStacks: string[] = []) =>
    new StacksOverlay(
      { terminal: { rows: 40 }, requestRender: () => {} },
      fakeTheme,
      { stacks, disabledStacks: [], discovered: skillsOnDisk(...discovered), projectStackNames: new Set(projectStacks) },
      {
        persist: (next) => {
          persisted = next;
          return outcome(false);
        },
        notify: (message) => notices.push(message),
        input: async () => undefined,
        confirm: async () => false,
        pick: async (_title, items) => {
          offered.push(items);
          return [items[0]!];
        },
        done: () => {},
      },
    );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  // gamma is in "two", so only delta is unstacked; picking it adds to the selected stack "one"
  make({ one: ["alpha"], two: ["gamma"] }, ["alpha", "gamma", "delta"]).handleInput("a");
  await tick();
  assert.deepEqual(offered, [["delta"]]);
  assert.deepEqual(persisted?.one, ["alpha", "delta"]);

  // nothing unstacked: notice, no dialog
  make({ one: ["alpha"] }, ["alpha"]).handleInput("a");
  await tick();
  assert.equal(offered.length, 1);
  assert.match(notices.at(-1)!, /already in a stack/);

  // project stack: notice, no dialog
  make({ one: ["alpha"] }, ["alpha", "delta"], ["one"]).handleInput("a");
  await tick();
  assert.equal(offered.length, 1);
  assert.match(notices.at(-1)!, /\.pi\/skill-stacks\.json/);
});
