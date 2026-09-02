import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { StacksOverlay } from "../extensions/overlay.ts";

// Regression guard for the width-cache crash class: every rendered line must
// fit the width the TUI passes in, at any terminal size.

const fakeTheme = {
  fg: (_color: string, text: string) => `\x1b[38;5;4m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[48;5;8m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

function makeOverlay(rows: number, overrides?: { stacks?: Record<string, string[]> }) {
  const requests: number[] = [];
  const overlay = new StacksOverlay(
    { terminal: { rows }, requestRender: () => requests.push(1) },
    fakeTheme,
    {
      stacks: overrides?.stacks ?? {
        matt: Array.from({ length: 28 }, (_, i) => `skill-${i}`),
        firecrawl: ["firecrawl-scrape", "ghost-skill", "an-extremely-long-skill-directory-name-here"],
        remotion: [],
        "a-very-long-stack-name-that-needs-truncation": ["alpha"],
      },
      disabledStacks: ["remotion"],
      discovered: new Set(["skill-0", "firecrawl-scrape", "alpha", "beta"]),
      projectStackNames: new Set(["remotion"]),
    },
    {
      persist: () => ({ summary: {} as never, missing: {}, settingsChanged: false }),
      notify: () => {},
      input: async () => undefined,
      confirm: async () => false,
      done: () => {},
    },
  );
  return { overlay, requests };
}

test("render: no line exceeds the width, across sizes, panes, and focus", () => {
  for (const rows of [10, 24, 40, 80]) {
    for (const width of [40, 50, 76, 100, 160, 200, 300]) {
      const { overlay } = makeOverlay(rows);
      for (const line of overlay.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `rows=${rows} width=${width}: line ${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`,
        );
      }
      // members focus renders the other pane layout
      overlay.handleInput("\t");
      for (const line of overlay.render(width)) {
        assert.ok(visibleWidth(line) <= width, `members focus rows=${rows} width=${width}`);
      }
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

test("handleInput: space toggles a stack and triggers persist via done state", () => {
  const { overlay } = makeOverlay(40);
  overlay.handleInput(" "); // disable "matt"
  // state change is visible on the next render: title shows reload pending
  const frame = overlay.render(100).join("\n");
  assert.match(frame, /reload pending/);
});

test("handleInput: esc closes with changed flag and outcome", async () => {
  const results: unknown[] = [];
  const overlay = new StacksOverlay(
    { terminal: { rows: 40 }, requestRender: () => {} },
    fakeTheme,
    {
      stacks: { one: ["alpha"] },
      disabledStacks: [],
      discovered: new Set(["alpha"]),
      projectStackNames: new Set(),
    },
    {
      persist: () => ({ summary: {} as never, missing: {}, settingsChanged: true }),
      notify: () => {},
      input: async () => undefined,
      confirm: async () => false,
      done: (result) => results.push(result),
    },
  );
  overlay.handleInput(" ");
  overlay.handleInput("\x1b");
  assert.deepEqual(results, [{ changed: true, outcome: { summary: {}, missing: {}, settingsChanged: true } }]);
});
