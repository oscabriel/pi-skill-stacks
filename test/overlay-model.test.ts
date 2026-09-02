import assert from "node:assert/strict";
import { test } from "node:test";
import { splitSectionRows, StacksOverlayModel } from "../src/overlay-model.ts";
import { skillsOnDisk } from "./helpers.ts";

function makeModel(overrides?: {
  stacks?: Record<string, string[]>;
  disabledStacks?: string[];
  projectStackNames?: string[];
}) {
  const discovered = skillsOnDisk("alpha", "beta", "gamma", "delta");
  return new StacksOverlayModel({
    stacks: overrides?.stacks ?? { one: ["alpha", "beta"], two: ["gamma"] },
    disabledStacks: overrides?.disabledStacks ?? [],
    discovered,
    projectStackNames: new Set(overrides?.projectStackNames ?? []),
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

test("toggleMembership adds an available skill to the selected stack", () => {
  const model = makeModel();
  // members of "one": alpha, beta; available: delta, gamma (sorted)
  model.setFocus("members");
  model.moveMember(3, 10, 10); // flat: alpha, beta, delta, gamma → onto gamma
  assert.equal(model.toggleMembership(), "added");
  assert.deepEqual(model.membersOf("one"), ["alpha", "beta", "gamma"]);
  assert.deepEqual(model.availableFor("one"), ["delta"]);
});

test("toggleMembership removes a member from the selected stack", () => {
  const model = makeModel();
  model.setFocus("members");
  assert.equal(model.toggleMembership(), "removed");
  assert.deepEqual(model.membersOf("one"), ["beta"]);
  assert.ok(model.availableFor("one").includes("alpha"));
});

test("toggleMembership is blocked for project-defined stacks", () => {
  const model = makeModel({ projectStackNames: ["one"] });
  model.setFocus("members");
  assert.equal(model.toggleMembership(), "blocked");
  assert.deepEqual(model.membersOf("one"), ["alpha", "beta"]);
});

test("membership changes update the excluded set immediately", () => {
  const model = makeModel({ disabledStacks: ["one"] });
  // alpha excluded: only stack "one" has it and "one" is off
  assert.ok(!model.isActiveSkill("alpha"));
  model.setFocus("members");
  // add gamma (in "two", still enabled) — adding it keeps it active
  model.moveMember(3, 10, 10); // flat: alpha, beta, delta, gamma → onto gamma
  assert.equal(model.toggleMembership(), "added");
  assert.ok(model.isActiveSkill("gamma"));
});

test("missing skills stay in members and are flagged, not available", () => {
  const model = makeModel({ stacks: { one: ["alpha", "ghost"] } });
  assert.deepEqual(model.membersOf("one"), ["alpha", "ghost"]);
  const members = model.memberWindow(10).items;
  const ghost = members.find((entry) => entry.name === "ghost")!;
  assert.ok(ghost.missing);
  assert.ok(!model.availableFor("one").includes("ghost"));
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

test("moveMember clamps at both ends and crosses the members/available boundary", () => {
  const model = makeModel();
  model.setFocus("members");
  model.moveMember(-5, 10, 10);
  assert.equal(model.memberIndex, 0);
  // members: alpha, beta; available: delta, gamma → flat length 4
  model.moveMember(10, 10, 10);
  assert.equal(model.memberIndex, 3);
  model.moveMember(1, 10, 10); // clamped, no wrap
  assert.equal(model.memberIndex, 3);
});

test("splitSectionRows: each section gets what it needs; only when both overflow is the space halved", () => {
  // both fit: members take their count, available gets the rest
  assert.deepEqual(splitSectionRows(40, 11, 20), { memberRows: 11, availableRows: 29 });
  // members small, available huge: available gets everything members don't need
  assert.deepEqual(splitSectionRows(40, 11, 65), { memberRows: 11, availableRows: 29 });
  // members huge, available small: mirror image
  assert.deepEqual(splitSectionRows(40, 65, 11), { memberRows: 29, availableRows: 11 });
  // both overflow: halve
  assert.deepEqual(splitSectionRows(40, 65, 65), { memberRows: 20, availableRows: 20 });
  assert.deepEqual(splitSectionRows(41, 65, 65), { memberRows: 21, availableRows: 20 });
  // empty members still gets one row for its hint; same for available
  assert.deepEqual(splitSectionRows(40, 0, 65), { memberRows: 1, availableRows: 39 });
  assert.deepEqual(splitSectionRows(40, 65, 0), { memberRows: 39, availableRows: 1 });
  // tiny terminal: never below one row each
  assert.deepEqual(splitSectionRows(2, 65, 65), { memberRows: 1, availableRows: 1 });
});

test("memberCursor reports the section and list-relative index of the flat cursor", () => {
  const model = makeModel();
  model.setFocus("members");
  // members: alpha, beta; available: delta, gamma
  assert.deepEqual(model.memberCursor, { section: "members", index: 0 });
  model.moveMember(1, 10, 10);
  assert.deepEqual(model.memberCursor, { section: "members", index: 1 });
  model.moveMember(1, 10, 10);
  assert.deepEqual(model.memberCursor, { section: "available", index: 0 });
  model.moveMember(1, 10, 10);
  assert.deepEqual(model.memberCursor, { section: "available", index: 1 });
});

test("moveMember scrolls within each section based on the given rows", () => {
  const model = makeModel({
    stacks: { one: ["alpha", "beta", "gamma", "delta"] },
  });
  model.setFocus("members");
  // member window of 2 rows
  model.moveMember(1, 2, 2);
  model.moveMember(1, 2, 2);
  assert.equal(model.memberIndex, 2);
  assert.equal(model.memberWindow(2).start, 1);
});

test("windows clamp when the list is shorter than the viewport", () => {
  const model = makeModel({ stacks: { one: ["alpha"] } });
  const memberWin = model.memberWindow(10);
  assert.equal(memberWin.start, 0);
  assert.equal(memberWin.items.length, 1);
  const availWin = model.availableWindow(10);
  assert.equal(availWin.items.length, 3); // beta, gamma, delta
});
