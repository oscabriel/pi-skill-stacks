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
  overrides?: {
    stacks?: Record<string, string[]>;
    settingsChanged?: boolean;
    skillContents?: ReadonlyMap<string, string>;
  },
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
      skillContents: overrides?.skillContents,
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

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("render: viewer pane opens to the right of members and every line still fits", () => {
  const contents = new Map([["alpha", "viewer heading\n\nviewer body marker"]]);
  for (const width of [40, 50, 76, 100, 160, 300]) {
    const { overlay } = makeOverlay(24, { skillContents: contents });
    overlay.handleInput("\t"); // members focus
    overlay.handleInput("\r"); // enter → viewer for skill-0
    assertFramesFit(overlay, width, `viewer width=${width}`);

    const lines = overlay.render(width).map(stripAnsi);
    // three panes: two inner separators per body row, plus the header row
    const bodyRows = lines.filter((line) => line.startsWith("│"));
    for (const row of bodyRows) {
      assert.equal(row.split("│").length - 1, 4, `expected four bars (three panes): ${row}`);
    }
    assert.match(lines.join("\n"), /heading/);
    assert.match(lines.join("\n"), /marker/);
    assert.match(lines.join("\n"), /\[↑↓\] scroll · \[←\/esc\] back/);
  }
});

test("render: closing the viewer restores the two-pane layout", () => {
  const { overlay } = makeOverlay(24);
  overlay.handleInput("\t");
  overlay.handleInput("\r");
  overlay.handleInput("\r"); // enter again in the viewer closes it
  const lines = overlay.render(100).map(stripAnsi);
  const bodyRows = lines.filter((line) => line.startsWith("│"));
  for (const row of bodyRows) assert.equal(row.split("│").length - 1, 3, row);
  assert.doesNotMatch(lines.join("\n"), /scroll/);
});

test("handleInput: enter on a missing skill notifies instead of opening the viewer", () => {
  const notices: string[] = [];
  const overlay = new StacksOverlay(
    { terminal: { rows: 24 }, requestRender: () => {} },
    fakeTheme,
    {
      stacks: { firecrawl: ["ghost-skill"] },
      disabledStacks: [],
      discovered: skillsOnDisk("firecrawl-scrape"),
      projectStackNames: new Set(),
      skillContents: new Map(),
    },
    {
      persist: () => outcome(false),
      notify: (message) => notices.push(message),
      input: async () => undefined,
      confirm: async () => false,
      pick: async () => undefined,
      done: () => {},
    },
  );
  overlay.handleInput("\t");
  overlay.handleInput("\r");
  assert.match(notices.at(-1)!, /ghost-skill/);
  const lines = overlay.render(100).map(stripAnsi);
  const bodyRows = lines.filter((line) => line.startsWith("│"));
  for (const row of bodyRows) assert.equal(row.split("│").length - 1, 3, row);
});

test("handleInput: j/k scroll the viewer content", () => {
  const body = Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n");
  const { overlay } = makeOverlay(24, {
    stacks: { one: ["alpha"] },
    skillContents: new Map([["alpha", body]]),
  });
  overlay.handleInput("\t");
  overlay.handleInput("\r");
  let joined = overlay.render(100).map(stripAnsi).join("\n");
  assert.match(joined, /row 0/);
  overlay.handleInput("j");
  joined = overlay.render(100).map(stripAnsi).join("\n");
  assert.doesNotMatch(joined, /row 0/);
  assert.match(joined, /row 1/);
  overlay.handleInput("k");
  joined = overlay.render(100).map(stripAnsi).join("\n");
  assert.match(joined, /row 0/);
});

test("handleInput: esc in the viewer returns to members", () => {
  const { overlay } = makeOverlay(24, { skillContents: new Map([["skill-0", "text"]]) });
  overlay.handleInput("\t");
  overlay.handleInput("\r");
  overlay.handleInput("\x1b");
  assert.doesNotMatch(overlay.render(100).join("\n"), /scroll/);
});

test("handleInput: →/tab in members opens the viewer, ← returns to stacks", () => {
  const { overlay } = makeOverlay(24, { skillContents: new Map([["skill-0", "text"]]) });
  overlay.handleInput("\t"); // members focus
  overlay.handleInput("\t"); // tab → viewer (forward)
  assert.match(overlay.render(100).map(stripAnsi).join("\n"), /\[↑↓\] scroll/);
  overlay.handleInput("\x1b[D"); // left arrow → back to members
  assert.match(overlay.render(100).map(stripAnsi).join("\n"), /\[↑↓\] move/);
  // the viewer closed, so right arrow is members-forward again: back into the viewer
  overlay.handleInput("\x1b[C");
  assert.match(overlay.render(100).map(stripAnsi).join("\n"), /\[↑↓\] scroll/);
  overlay.handleInput("\x1b"); // esc → members
  overlay.handleInput("\x1b[D"); // left → stacks
  assert.match(overlay.render(100).map(stripAnsi).join("\n"), /\[↑↓\] select/);
});

test("handleInput: →/tab in the viewer are no-ops (viewer is the last pane)", () => {
  const { overlay } = makeOverlay(24, { skillContents: new Map([["skill-0", "text"]]) });
  overlay.handleInput("\t");
  overlay.handleInput("\r");
  overlay.handleInput("\t");
  assert.match(overlay.render(100).map(stripAnsi).join("\n"), /\[↑↓\] scroll/);
  overlay.handleInput("\x1b[C");
  assert.match(overlay.render(100).map(stripAnsi).join("\n"), /\[↑↓\] scroll/);
});

test("handleInput: mouse wheel scrolls the viewer", () => {
  const body = Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n");
  const { overlay } = makeOverlay(24, {
    stacks: { one: ["alpha"] },
    skillContents: new Map([["alpha", body]]),
  });
  overlay.handleInput("\t");
  overlay.handleInput("\r");
  overlay.handleInput("\x1b[<65;30;12M"); // wheel down
  let joined = overlay.render(100).map(stripAnsi).join("\n");
  assert.doesNotMatch(joined, /row 0/);
  assert.match(joined, /row 1/);
  overlay.handleInput("\x1b[<64;30;12M"); // wheel up
  joined = overlay.render(100).map(stripAnsi).join("\n");
  assert.match(joined, /row 0/);
  // legacy X10 encoding scrolls too (tmux translates to this sometimes)
  overlay.handleInput("\x1b[M`##"); // button byte 0x60 = 32+64 → wheel up
  assert.match(overlay.render(100).map(stripAnsi).join("\n"), /row 0/);
});

test("handleInput: wheel events outside the viewer are ignored", () => {
  const { overlay } = makeOverlay(24, { skillContents: new Map([["skill-0", "text"]]) });
  overlay.handleInput("\x1b[<65;30;12M"); // wheel down in stacks focus
  assert.match(overlay.render(100).map(stripAnsi).join("\n"), /\[↑↓\] select/);
  overlay.handleInput("\t");
  overlay.handleInput("\x1b[<65;30;12M"); // wheel down in members focus
  assert.match(overlay.render(100).map(stripAnsi).join("\n"), /\[↑↓\] move/);
});

test("render: title is compact and the help bar brackets the keys", () => {
  const { overlay } = makeOverlay(24);
  const lines = overlay.render(100).map(stripAnsi);
  assert.match(lines[0]!, /skill stacks \(4\) · \d+\/\d+ active/);
  // full help bar needs width; frameEdge truncates it on narrow terminals
  const help = overlay.render(160).map(stripAnsi).at(-1)!;
  assert.match(help, /\[space\] on\/off · \[→\/tab\] members/);
  assert.match(help, /\[esc\] close/);
  overlay.handleInput("\t");
  const membersHelp = overlay.render(160).map(stripAnsi).at(-1)!;
  assert.match(membersHelp, /\[enter\/→\/tab\] view/);
  assert.match(membersHelp, /\[←\/esc\] back/);
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
