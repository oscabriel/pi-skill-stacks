import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeExcludedSkills,
  desiredExclusions,
  exclusionPatternFor,
  mergeStacks,
  missingSkillNames,
  nextDisabledStacks,
  planSkillsSetting,
  scopeManagedExclusions,
  summarizeStacks,
} from "../src/core.ts";
import { skillsOnDisk } from "./helpers.ts";

test("mergeStacks: project stacks add to and override global stacks", () => {
  const merged = mergeStacks(
    { alpha: ["a", "b"], beta: ["c"] },
    { beta: ["c", "d"], gamma: ["e"] },
  );
  assert.deepEqual(merged, {
    alpha: ["a", "b"],
    beta: ["c", "d"],
    gamma: ["e"],
  });
});

test("mergeStacks: no project config leaves global untouched", () => {
  const merged = mergeStacks({ alpha: ["a"] }, undefined);
  assert.deepEqual(merged, { alpha: ["a"] });
});

test("missingSkillNames: reports names absent from discovery, per stack", () => {
  const missing = missingSkillNames(
    { alpha: ["real", "ghost"], beta: ["real"] },
    skillsOnDisk("real"),
  );
  assert.deepEqual(missing, { alpha: ["ghost"] });
});

test("computeExcludedSkills: skill stays enabled if any enabled stack contains it", () => {
  // "shared" is in a disabled stack and an enabled one; must stay enabled.
  const excluded = computeExcludedSkills(
    { on: ["shared", "only-on"], off: ["shared", "only-off"] },
    ["off"],
  );
  assert.deepEqual([...excluded].sort(), ["only-off"]);
});

test("computeExcludedSkills: skills in no stack are never excluded", () => {
  const excluded = computeExcludedSkills({ off: ["a"] }, ["off"]);
  assert.ok(!excluded.has("unlisted"));
  assert.deepEqual([...excluded], ["a"]);
});

test("computeExcludedSkills: nothing excluded when all stacks enabled", () => {
  const excluded = computeExcludedSkills({ a: ["x"], b: ["y"] }, []);
  assert.equal(excluded.size, 0);
});

test("exclusionPatternFor: negates the baseDir-relative SKILL.md path", () => {
  assert.equal(exclusionPatternFor("skills/firecrawl-map/SKILL.md"), "!skills/firecrawl-map/SKILL.md");
  assert.equal(exclusionPatternFor("skills/group/nested/SKILL.md"), "!skills/group/nested/SKILL.md");
});

test("desiredExclusions: patterns for excluded skills that exist on disk, sorted; nested paths kept", () => {
  const discovered = new Map([
    ["b", "skills/b/SKILL.md"],
    ["a", "skills/group/a/SKILL.md"],
  ]);
  const patterns = desiredExclusions({ off: ["b", "a", "ghost"] }, ["off"], discovered);
  assert.deepEqual(patterns, ["!skills/b/SKILL.md", "!skills/group/a/SKILL.md"]);
});

test("scopeManagedExclusions: keeps patterns for on-disk skills that no visible stack claims", () => {
  const discovered = skillsOnDisk("visible", "elsewhere");
  const managed = [
    "!skills/visible/SKILL.md", // in a stack we can see → rewritable
    "!skills/elsewhere/SKILL.md", // on disk, in no visible stack → another cwd's project stack
    "!skills/deleted/SKILL.md", // skill dir gone → clean up
  ];
  const scoped = scopeManagedExclusions(managed, { s: ["visible"] }, discovered);
  assert.deepEqual(scoped.retained, ["!skills/elsewhere/SKILL.md"]);
  assert.deepEqual(scoped.inScope, ["!skills/visible/SKILL.md", "!skills/deleted/SKILL.md"]);
});

test("nextDisabledStacks: replaces entries for visible stacks, preserves unseen ones, sorted + deduped", () => {
  const next = nextDisabledStacks(
    ["zeta-project-only", "seen-off", "seen-deleted"],
    ["seen-off", "seen-deleted", "seen-on"],
    ["seen-on", "seen-on"],
  );
  assert.deepEqual(next, ["seen-on", "zeta-project-only"]);
});

test("planSkillsSetting: removes only managed entries, keeps user-written ones", () => {
  const userWritten = "!skills/hand-off-limits/SKILL.md";
  const managed = "!skills/firecrawl-map/SKILL.md";
  const plan = planSkillsSetting([userWritten, managed, "extra/path"], [managed], []);
  assert.deepEqual(plan.skills, [userWritten, "extra/path"]);
  assert.deepEqual(plan.managed, []);
});

test("planSkillsSetting: appends new exclusions and claims them as managed", () => {
  const plan = planSkillsSetting(["extra/path"], [], ["!skills/a/SKILL.md", "!skills/b/SKILL.md"]);
  assert.deepEqual(plan.skills, ["extra/path", "!skills/a/SKILL.md", "!skills/b/SKILL.md"]);
  assert.deepEqual(plan.managed, ["!skills/a/SKILL.md", "!skills/b/SKILL.md"]);
});

test("planSkillsSetting: does not duplicate or claim a pattern the user already wrote", () => {
  const userWritten = "!skills/a/SKILL.md";
  const plan = planSkillsSetting([userWritten], [], [userWritten, "!skills/b/SKILL.md"]);
  assert.deepEqual(plan.skills, [userWritten, "!skills/b/SKILL.md"]);
  assert.deepEqual(plan.managed, ["!skills/b/SKILL.md"]);
});

test("planSkillsSetting: re-applying the same state is a no-op", () => {
  const managed = ["!skills/a/SKILL.md"];
  const current = ["extra/path", ...managed];
  const plan = planSkillsSetting(current, managed, managed);
  assert.deepEqual(plan.skills, current);
  assert.deepEqual(plan.managed, managed);
});

test("summarizeStacks: counts stacks, active skills, and names disabled stacks", () => {
  const summary = summarizeStacks(
    { on: ["a", "b"], off: ["c", "d"] },
    ["off"],
    skillsOnDisk("a", "b", "c", "d", "unlisted"),
  );
  assert.equal(summary.stackCount, 2);
  assert.deepEqual(summary.offStacks, ["off"]);
  assert.equal(summary.totalCount, 5);
  // a, b, unlisted stay active; c, d are excluded. Only "unlisted" is in no stack.
  assert.equal(summary.activeCount, 3);
  assert.equal(summary.unstackedCount, 1);
  assert.deepEqual(summary.stacks, [
    { name: "on", size: 2, enabled: true },
    { name: "off", size: 2, enabled: false },
  ]);
});

test("summarizeStacks: stack sizes count only discovered members", () => {
  const summary = summarizeStacks({ alpha: ["real", "ghost"] }, [], skillsOnDisk("real"));
  assert.deepEqual(summary.stacks, [{ name: "alpha", size: 1, enabled: true }]);
});

test("summarizeStacks: excluded count only covers discovered skills", () => {
  const summary = summarizeStacks({ off: ["ghost", "real"] }, ["off"], skillsOnDisk("real"));
  assert.equal(summary.totalCount, 1);
  assert.equal(summary.activeCount, 0);
  // ghost is stacked but missing from disk, so it doesn't count as unstacked.
  assert.equal(summary.unstackedCount, 0);
});
