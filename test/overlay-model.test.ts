import assert from "node:assert/strict";
import { test } from "node:test";
import { StacksOverlayModel } from "../src/overlay-model.ts";
import { skillsOnDisk } from "./helpers.ts";

const defaultContents = new Map([
  ["alpha", "alpha line one\n\nalpha line two"],
  ["beta", "beta body"],
  ["gamma", "gamma body"],
  ["delta", "delta body"],
]);

function makeModel(overrides?: {
  stacks?: Record<string, string[]>;
  disabledStacks?: string[];
  projectStackNames?: string[];
  skillContents?: ReadonlyMap<string, string>;
}) {
  const discovered = skillsOnDisk("alpha", "beta", "gamma", "delta");
  return new StacksOverlayModel({
    stacks: overrides?.stacks ?? { one: ["alpha", "beta"], two: ["gamma"] },
    disabledStacks: overrides?.disabledStacks ?? [],
    discovered,
    projectStackNames: new Set(overrides?.projectStackNames ?? []),
    skillContents: overrides?.skillContents ?? defaultContents,
  });
}

test("toggleStack flips on/off and recomputes excluded skills", () => {
  const model = makeModel();
  assert.equal(model.selectedStack, "one");
  assert.ok(model.isActiveSkill("alpha"));

  model.toggleStack();
  assert.ok(model.isDisabled("one"));
  // alpha is only in "one", so it is now excluded
  assert.ok(!model.isActiveSkill("alpha"));
  // gamma lives in "two" and stays active
  assert.ok(model.isActiveSkill("gamma"));

  model.moveStack(1, 10);
  model.toggleStack();
  assert.ok(model.isDisabled("two"));
  assert.ok(!model.isActiveSkill("gamma"));
});

test("toggleStack: overlap rule keeps a skill active while any enabled stack has it", () => {
  const model = makeModel({ stacks: { one: ["alpha"], two: ["alpha", "gamma"] } });
  model.toggleStack(); // disable "one"
  assert.ok(model.isActiveSkill("alpha"));
  model.moveStack(1, 10);
  model.toggleStack(); // disable "two" too
  assert.ok(!model.isActiveSkill("alpha"));
});

test("removeMember drops the member under the cursor from the selected stack", () => {
  const model = makeModel();
  model.setFocus("members");
  model.moveMember(1, 10); // onto beta
  assert.equal(model.removeMember(), "removed");
  assert.deepEqual(model.membersOf("one"), ["alpha"]);
  assert.deepEqual(model.unstackedSkills(), ["beta", "delta"]);
  assert.equal(model.memberIndex, 0, "cursor clamps back onto the remaining member");
});

test("removeMember is blocked for project-defined stacks and empty stacks", () => {
  const model = makeModel({ projectStackNames: ["one"] });
  model.setFocus("members");
  assert.equal(model.removeMember(), "blocked");
  assert.deepEqual(model.membersOf("one"), ["alpha", "beta"]);

  const empty = makeModel({ stacks: { one: [] } });
  assert.equal(empty.removeMember(), "blocked");
});

test("membership changes update the excluded set immediately", () => {
  const model = makeModel({ disabledStacks: ["two"] });
  // gamma excluded: only stack "two" has it and "two" is off
  assert.ok(!model.isActiveSkill("gamma"));
  // adding gamma to the enabled stack "one" makes it active again
  assert.equal(model.addSkills(["gamma"]), "added");
  assert.ok(model.isActiveSkill("gamma"));
  // removing alpha from "one" (the only stack holding it) leaves it unstacked, hence active
  model.setFocus("members");
  assert.equal(model.removeMember(), "removed");
  assert.ok(model.isActiveSkill("alpha"));
});

test("missing skills stay in members and are flagged; they are not unstacked", () => {
  const model = makeModel({ stacks: { one: ["alpha", "ghost"] } });
  assert.deepEqual(model.membersOf("one"), ["alpha", "ghost"]);
  const members = model.memberWindow(10).items;
  const ghost = members.find((entry) => entry.name === "ghost")!;
  assert.ok(ghost.missing);
  assert.ok(!model.unstackedSkills().includes("ghost"));
});

test("createStack adds an empty stack, selects it, and rejects duplicates", () => {
  const model = makeModel();
  assert.equal(model.createStack("three"), true);
  assert.equal(model.selectedStack, "three");
  assert.deepEqual(model.membersOf("three"), []);
  assert.equal(model.createStack("three"), false);
  assert.equal(model.createStack("  "), false);
});

test("createStack lands in sorted position and scrolling follows it", () => {
  const model = makeModel({ stacks: { a: [], m: [], z: [] } });
  model.moveStack(2, 2); // viewport of 2 rows, on "z"
  assert.equal(model.stackWindow(2).start, 1);
  model.createStack("n");
  assert.equal(model.selectedStack, "n");
  assert.ok(model.stackWindow(2).items.some((entry) => entry.name === "n"));
});

test("deleteSelectedStack removes the definition and its disabled entry", () => {
  const model = makeModel({ disabledStacks: ["one"] });
  assert.equal(model.deleteSelectedStack(), "deleted");
  assert.ok(!model.stackList().includes("one"));
  assert.deepEqual(
    model.snapshot().disabledStacks.filter((name) => name === "one"),
    [],
  );
  assert.equal(model.selectedStack, "two");
});

test("deleteSelectedStack is blocked for project-defined stacks", () => {
  const model = makeModel({ projectStackNames: ["one"] });
  assert.equal(model.deleteSelectedStack(), "blocked");
  assert.ok(model.stackList().includes("one"));
});

test("snapshot returns a deep copy with sorted disabledStacks", () => {
  const model = makeModel({ disabledStacks: ["two", "one"] });
  const snapshot = model.snapshot();
  assert.deepEqual(snapshot.disabledStacks, ["one", "two"]);
  snapshot.stacks.one!.push("mutated");
  assert.ok(!model.membersOf("one").includes("mutated"));
});

test("moveMember clamps at both ends", () => {
  const model = makeModel();
  model.setFocus("members");
  model.moveMember(-5, 10);
  assert.equal(model.memberIndex, 0);
  model.moveMember(10, 10); // members: alpha, beta
  assert.equal(model.memberIndex, 1);
  model.moveMember(1, 10); // clamped, no wrap
  assert.equal(model.memberIndex, 1);
});

test("unstackedSkills lists discovered skills that no stack holds", () => {
  const model = makeModel(); // one: alpha, beta; two: gamma; discovered adds delta
  assert.deepEqual(model.unstackedSkills(), ["delta"]);
  model.toggleStack(); // disabling a stack does not unstack its skills
  assert.deepEqual(model.unstackedSkills(), ["delta"]);
});

test("addSkills appends to the selected stack, skips duplicates, refuses project stacks", () => {
  const model = makeModel();
  assert.equal(model.addSkills(["delta", "alpha", "delta"]), "added");
  assert.deepEqual(model.membersOf("one"), ["alpha", "beta", "delta"]);
  assert.deepEqual(model.unstackedSkills(), []);
  assert.equal(model.addSkills([]), "blocked");

  const locked = makeModel({ projectStackNames: ["one"] });
  assert.equal(locked.addSkills(["delta"]), "blocked");
  assert.deepEqual(locked.membersOf("one"), ["alpha", "beta"]);
});

test("moveMember scrolls within each section based on the given rows", () => {
  const model = makeModel({
    stacks: { one: ["alpha", "beta", "gamma", "delta"] },
  });
  model.setFocus("members");
  // member window of 2 rows
  model.moveMember(1, 2);
  model.moveMember(1, 2);
  assert.equal(model.memberIndex, 2);
  assert.equal(model.memberWindow(2).start, 1);
});

test("openViewer shows the selected member's markdown in the viewer pane", () => {
  const model = makeModel();
  model.setFocus("members");
  assert.equal(model.openViewer(), true);
  assert.equal(model.focus, "viewer");
  assert.equal(model.viewerOpen, true);
  const win = model.viewerWindow(20, 10);
  assert.deepEqual(win.items.slice(0, 3), ["alpha line one", "", "alpha line two"]);
  assert.equal(win.start, 0);
});

test("openViewer wraps long lines to the pane width", () => {
  const body = "first\n" + "word ".repeat(10) + "end";
  const model = makeModel({
    stacks: { one: ["alpha"] },
    skillContents: new Map([["alpha", body]]),
  });
  model.setFocus("members");
  model.openViewer();
  const lines = model.viewerWindow(12, 100).items;
  assert.equal(lines[0], "first");
  for (const line of lines) assert.ok(line.length <= 12, `line too wide: ${line}`);
  assert.equal(lines.join(" "), body.replace("\n", " "));
});

test("openViewer is refused for missing skills and empty stacks", () => {
  const ghost = makeModel({ stacks: { one: ["ghost"] } });
  ghost.setFocus("members");
  assert.equal(ghost.openViewer(), false);
  assert.equal(ghost.focus, "members");

  const empty = makeModel({ stacks: { one: [] } });
  empty.setFocus("members");
  assert.equal(empty.openViewer(), false);
});

test("openViewer for a discovered skill with no readable content shows an empty viewer", () => {
  const model = makeModel({ stacks: { one: ["alpha"] }, skillContents: new Map() });
  model.setFocus("members");
  assert.equal(model.openViewer(), true);
  assert.deepEqual(model.viewerWindow(20, 10).items, []);
});

test("moveViewer scrolls the viewport and clamps at both ends", () => {
  const body = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
  const model = makeModel({ stacks: { one: ["alpha"] }, skillContents: new Map([["alpha", body]]) });
  model.setFocus("members");
  model.openViewer();
  model.moveViewer(5, 20, 10);
  assert.equal(model.viewerWindow(20, 10).start, 5);
  assert.equal(model.viewerWindow(20, 10).items[0], "row 5");
  model.moveViewer(-100, 20, 10);
  assert.equal(model.viewerWindow(20, 10).start, 0);
  model.moveViewer(100, 20, 10);
  assert.equal(model.viewerWindow(20, 10).start, 20, "last page starts at total - rows");
  assert.equal(model.viewerWindow(20, 10).items.at(-1), "row 29");
});

test("closeViewer returns focus to members and reopening resets the scroll", () => {
  const body = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
  const model = makeModel({ stacks: { one: ["alpha"] }, skillContents: new Map([["alpha", body]]) });
  model.setFocus("members");
  model.openViewer();
  model.moveViewer(7, 20, 10);
  model.closeViewer();
  assert.equal(model.focus, "members");
  assert.equal(model.viewerOpen, false);
  model.openViewer();
  assert.equal(model.viewerWindow(20, 10).start, 0);
});

test("the viewer re-wraps when the pane width changes", () => {
  const model = makeModel({ stacks: { one: ["alpha"] } });
  model.setFocus("members");
  model.openViewer();
  const wide = model.viewerWindow(40, 100).items;
  const narrow = model.viewerWindow(10, 100).items;
  assert.equal(wide.length, 3);
  assert.ok(narrow.length > 3);
});

test("windows clamp when the list is shorter than the viewport", () => {
  const model = makeModel({ stacks: { one: ["alpha"] } });
  const memberWin = model.memberWindow(10);
  assert.equal(memberWin.start, 0);
  assert.equal(memberWin.items.length, 1);
  const stackWin = model.stackWindow(10);
  assert.equal(stackWin.start, 0);
  assert.equal(stackWin.items.length, 1);
});
