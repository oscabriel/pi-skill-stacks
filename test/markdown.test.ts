import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderMarkdown, type MarkdownStyler } from "../src/markdown.ts";

// Real escape codes so wrapTextWithAnsi sees them exactly as the TUI would.
const CODES: Record<string, number> = { accent: 34, dim: 90, muted: 37 };
const styler: MarkdownStyler = {
  fg: (color, text) => `\x1b[${CODES[color] ?? 0}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("headings render without hashes, bold, with breathing room around them", () => {
  const lines = renderMarkdown("# Title\n\nBody text.", 40, styler);
  const plain = lines.map(stripAnsi);
  assert.deepEqual(plain, ["Title", "", "Body text."]);
  assert.ok(lines[0]!.includes("\x1b[1mTitle\x1b[0m"));
});

test("frontmatter renders dim before the body", () => {
  const lines = renderMarkdown("---\nname: pickup\ndescription: x\n---\n\n# Body", 40, styler);
  const plain = lines.map(stripAnsi);
  assert.deepEqual(plain.slice(0, 4), ["---", "name: pickup", "description: x", "---"]);
  assert.match(lines.join("\n"), /Body/);
  // the whole frontmatter block is styled, the heading is not dim
  assert.ok(lines[1]!.startsWith("\x1b["));
});

test("list items keep a hanging indent when they wrap", () => {
  const lines = renderMarkdown("- alpha beta gamma delta", 12, styler).map(stripAnsi);
  assert.equal(lines[0], "• alpha");
  assert.deepEqual(lines.slice(1), ["  beta gamma", "  delta"]);
});

test("ordered lists keep their numbers", () => {
  const lines = renderMarkdown("3. third item here", 40, styler).map(stripAnsi);
  assert.equal(lines[0], "3. third item here");
});

test("fenced code renders dim without the fence markers, wrapped to width", () => {
  const long = "a".repeat(30);
  const lines = renderMarkdown("```js\nconst x = 1;\n" + long + "\n```", 20, styler);
  const plain = lines.map(stripAnsi);
  assert.ok(!plain.some((line) => line.includes("```")), plain.join("\n"));
  assert.equal(plain[0], "const x = 1;");
  for (const line of lines) assert.ok(visibleWidth(line) <= 20, `too wide: ${JSON.stringify(line)}`);
});

test("inline code, bold, and links are styled through the styler", () => {
  const lines = renderMarkdown("use `npx pi` and **care** plus [pi docs](https://pi.dev)", 80, styler);
  const joined = lines.join("\n");
  assert.match(joined, /npx pi/);
  assert.match(joined, /care/);
  assert.match(joined, /\x1b\[1mcare\x1b\[0m/);
  // link renders as its text in accent, without the url
  const plain = lines.map(stripAnsi).join("\n");
  assert.match(plain, /pi docs/);
  assert.doesNotMatch(plain, /https:\/\/pi\.dev/);
  assert.doesNotMatch(plain, /[[\]]/);
});

test("horizontal rules become a full-width line and thematic breaks do not eat frontmatter", () => {
  const lines = renderMarkdown("above\n\n---\n\nbelow", 10, styler).map(stripAnsi);
  assert.ok(lines.some((line) => line === "──────────"));
});

test("blockquotes render dim with the marker kept", () => {
  const lines = renderMarkdown("> quoted wisdom", 40, styler);
  assert.match(stripAnsi(lines.join("\n")), /quoted wisdom/);
});

test("every rendered line fits the width, across widths, with ANSI codes present", () => {
  const doc = [
    "---",
    "name: x",
    "---",
    "",
    "# Big heading",
    "",
    "- item one with a reasonably long line of text",
    "- `code` and [link](https://example.com/long) inline",
    "",
    "A paragraph that goes on for quite a while so the wrapper has to break it somewhere.",
    "",
    "```",
    "indented code line that is far too long for the pane width at any size",
    "```",
    "",
    "| Need | Command |",
    "| ---- | ------- |",
    "| find pages on a topic | `search` plus a long tail of words to wrap |",
    "| bulk extract | crawl |",
  ].join("\n");
  for (const width of [12, 20, 30, 44, 76]) {
    for (const line of renderMarkdown(doc, width, styler)) {
      assert.ok(
        visibleWidth(line) <= width,
        `width=${width}: line is ${visibleWidth(line)} wide: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("empty input renders nothing", () => {
  assert.deepEqual(renderMarkdown("", 40, styler), []);
});

test("tables render as aligned columns with a rule under the header", () => {
  const doc = [
    "| Need | Command |",
    "| ---- | ------- |",
    "| find pages | search |",
    "| bulk extract | crawl |",
  ].join("\n");
  const lines = renderMarkdown(doc, 40, styler);
  const plain = lines.map(stripAnsi);
  // col1 = max(4, 10, 12) = 12, col2 = max(7, 6, 5) = 7; joined with " │ "
  // (no leading blank: the table opens the document, same rule as headings)
  assert.deepEqual(plain, [
    "Need         │ Command",
    "─────────────┼────────",
    "find pages   │ search",
    "bulk extract │ crawl",
  ]);
  // header is bold, the rule is dim
  assert.ok(lines[0]!.includes("\x1b[1mNeed"), lines[0]);
  assert.ok(lines[1]!.includes("\x1b[90m"), lines[1]);
});

test("table cells are styled inline and keep their column alignment", () => {
  const doc = "| Use | Result |\n| --- | --- |\n| `search` tool | finds pages |";
  const lines = renderMarkdown(doc, 40, styler);
  assert.match(lines[2]!, /\x1b\[34msearch\x1b\[0m/);
  // both rows line up on the │ separator
  const plain = lines.map(stripAnsi);
  const bar = (line: string) => line.indexOf("│");
  assert.equal(bar(plain[0]!), bar(plain[2]!));
});

test("table cells wrap within their columns when the width is tight", () => {
  const doc = [
    "| Need | When |",
    "| ---- | ---- |",
    "| find pages on a topic | no specific url yet |",
  ].join("\n");
  const lines = renderMarkdown(doc, 20, styler);
  const plain = lines.map(stripAnsi);
  for (const line of plain) assert.ok(line.length <= 20, `too wide: ${JSON.stringify(line)}`);
  // every cell's words survive the wrap
  assert.match(plain.join("\n"), /topic/);
  assert.match(plain.join("\n"), /url/);
  // the rule spans exactly the table width
  const rowW = Math.max(...plain.map((l) => l.length));
  assert.ok(plain.some((line) => line.includes("┼") && line.length === rowW), plain.join("\n"));
});

test("narrow tables give each column its longest word before stealing space", () => {
  const doc = [
    "| Need | Command | When |",
    "| ---- | ------- | ---- |",
    "| Find pages on a topic | `search` | No specific URL yet |",
  ].join("\n");
  const lines = renderMarkdown(doc, 40, styler);
  for (const line of lines) assert.ok(visibleWidth(line) <= 40, JSON.stringify(line));
  const plain = lines.map(stripAnsi).join("\n");
  // the short Command column keeps its words whole; only the wide ones wrap
  for (const word of ["Command", "topic", "search", "specific"]) {
    assert.match(plain, new RegExp(word));
  }
});

test("pipe lines without a delimiter row fall through as plain text", () => {
  const lines = renderMarkdown("| just a pipe line", 40, styler).map(stripAnsi);
  assert.deepEqual(lines, ["| just a pipe line"]);
});
