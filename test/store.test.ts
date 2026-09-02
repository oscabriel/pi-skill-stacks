import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  discoverSkillNames,
  loadStacksConfig,
  saveStacksConfig,
  updateSettingsSkills,
} from "../src/store.ts";

const tmp = mkdtempSync(join(tmpdir(), "skill-stacks-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("discoverSkillNames: finds SKILL.md dirs across roots, ignores strays", () => {
  const rootA = join(tmp, "agents-skills");
  const rootB = join(tmp, "pi-skills");
  mkdirSync(join(rootA, "alpha"), { recursive: true });
  writeFileSync(join(rootA, "alpha", "SKILL.md"), "# a");
  mkdirSync(join(rootA, "no-skill-file"), { recursive: true });
  mkdirSync(join(rootB, "beta"), { recursive: true });
  writeFileSync(join(rootB, "beta", "SKILL.md"), "# b");
  writeFileSync(join(rootA, "loose-file.md"), "not a skill");

  const names = discoverSkillNames([rootA, rootB, join(tmp, "missing-root")]);
  assert.deepEqual([...names].sort(), ["alpha", "beta"]);
});

test("stacks config: load tolerates a missing file, save round-trips", () => {
  const path = join(tmp, "skill-stacks.json");
  const empty = loadStacksConfig(path);
  assert.deepEqual(empty, { stacks: {}, disabledStacks: [], managedExclusions: [] });

  const config = {
    stacks: { alpha: ["a"] },
    disabledStacks: ["alpha"],
    managedExclusions: ["!skills/a/SKILL.md"],
  };
  saveStacksConfig(path, config);
  assert.deepEqual(loadStacksConfig(path), config);
});

test("loadStacksConfig: ignores malformed shapes instead of throwing", () => {
  const path = join(tmp, "bad-stacks.json");
  writeFileSync(path, JSON.stringify({ stacks: { alpha: "not-an-array" }, disabledStacks: 42 }));
  const config = loadStacksConfig(path);
  assert.deepEqual(config, { stacks: {}, disabledStacks: [], managedExclusions: [] });
});

test("loadStacksConfig: keeps disabledStacks when stacks is empty (project-only setups)", () => {
  const path = join(tmp, "project-only.json");
  saveStacksConfig(path, {
    stacks: {},
    disabledStacks: ["remotion"],
    managedExclusions: ["!skills/remotion/SKILL.md"],
  });
  assert.deepEqual(loadStacksConfig(path), {
    stacks: {},
    disabledStacks: ["remotion"],
    managedExclusions: ["!skills/remotion/SKILL.md"],
  });
});

test("updateSettingsSkills: rewrites only the skills array, preserves other keys", () => {
  const path = join(tmp, "settings.json");
  writeFileSync(path, JSON.stringify({ theme: "dark", skills: ["old"] }, null, 2));
  updateSettingsSkills(path, ["!skills/a/SKILL.md"]);
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(parsed.theme, "dark");
  assert.deepEqual(parsed.skills, ["!skills/a/SKILL.md"]);
});
