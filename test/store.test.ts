import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  ConfigError,
  discoverSkills,
  loadProjectStacks,
  loadStacksConfig,
  readSettingsSkills,
  readSkillContents,
  saveStacksConfig,
  updateSettingsSkills,
} from "../src/store.ts";

const tmp = mkdtempSync(join(tmpdir(), "skill-stacks-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function skillDir(root: string, ...segments: string[]) {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\ndescription: x\n---\n# skill");
  return dir;
}

test("discoverSkills: maps names to baseDir-relative SKILL.md paths across roots", () => {
  const agents = join(tmp, "agents");
  const agent = join(tmp, "agent");
  skillDir(agents, "skills", "alpha");
  mkdirSync(join(agents, "skills", "no-skill-file"), { recursive: true });
  writeFileSync(join(agents, "skills", "loose-file.md"), "not a skill");
  skillDir(agent, "skills", "beta");

  const skills = discoverSkills([
    { dir: join(agents, "skills"), baseDir: agents },
    { dir: join(agent, "skills"), baseDir: agent },
    { dir: join(tmp, "missing-root"), baseDir: tmp },
  ]);
  assert.deepEqual(
    [...skills].sort(),
    [
      ["alpha", "skills/alpha/SKILL.md"],
      ["beta", "skills/beta/SKILL.md"],
    ],
  );
});

test("readSkillContents: resolves through roots in order and keeps frontmatter", () => {
  const base = join(tmp, "contents");
  const root2 = join(tmp, "contents2");
  skillDir(base, "skills", "alpha");
  writeFileSync(join(base, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: x\n---\n# Body\n\ntext");
  skillDir(root2, "skills", "beta");

  const roots = [
    { dir: join(base, "skills"), baseDir: base },
    { dir: join(root2, "skills"), baseDir: root2 },
  ];
  const contents = readSkillContents(discoverSkills(roots), roots);
  assert.equal(contents.get("alpha"), "---\nname: alpha\ndescription: x\n---\n# Body\n\ntext");
  assert.equal(contents.get("beta"), "---\ndescription: x\n---\n# skill");
});

test("discoverSkills: recurses like pi (nested skills, frontmatter names, skips dot-dirs/node_modules)", () => {
  const base = join(tmp, "nested");
  skillDir(base, "skills", "group", "inner");
  writeFileSync(
    join(skillDir(base, "skills", "renamed-dir"), "SKILL.md"),
    '---\nname: "custom-name"\ndescription: x\n---\n',
  );
  skillDir(base, "skills", ".hidden", "secret");
  skillDir(base, "skills", "node_modules", "dep");
  // a SKILL.md dir is a leaf: skills below it are not discovered
  skillDir(base, "skills", "group", "inner", "deeper");
  symlinkSync(join(base, "skills", "group"), join(base, "skills", "linked-group"));

  const skills = discoverSkills([{ dir: join(base, "skills"), baseDir: base }]);
  assert.deepEqual(
    [...skills].sort(),
    [
      ["custom-name", "skills/renamed-dir/SKILL.md"],
      ["inner", "skills/group/inner/SKILL.md"],
    ],
  );
});

test("stacks config: load tolerates a missing file, save round-trips", () => {
  const path = join(tmp, "skill-stacks.json");
  assert.deepEqual(loadStacksConfig(path), { stacks: {}, disabledStacks: [], managedExclusions: [] });

  const config = {
    stacks: { alpha: ["a"] },
    disabledStacks: ["alpha"],
    managedExclusions: ["!skills/a/SKILL.md"],
  };
  saveStacksConfig(path, config);
  assert.deepEqual(loadStacksConfig(path), config);
});

test("loadStacksConfig: a malformed stack entry fails loud instead of erasing the others", () => {
  const path = join(tmp, "bad-stacks.json");
  writeFileSync(path, JSON.stringify({ stacks: { good: ["a"], alpha: "not-an-array" } }));
  assert.throws(() => loadStacksConfig(path), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /stack "alpha"/);
    return true;
  });
});

test("loadStacksConfig: malformed disabledStacks and invalid JSON both throw ConfigError", () => {
  const path = join(tmp, "bad-disabled.json");
  writeFileSync(path, JSON.stringify({ stacks: {}, disabledStacks: 42 }));
  assert.throws(() => loadStacksConfig(path), ConfigError);
  writeFileSync(path, "{ not json");
  assert.throws(() => loadStacksConfig(path), ConfigError);
});

test("loadStacksConfig: keeps disabledStacks when stacks is empty (project-only setups)", () => {
  const path = join(tmp, "project-only.json");
  const config = {
    stacks: {},
    disabledStacks: ["remotion"],
    managedExclusions: ["!skills/remotion/SKILL.md"],
  };
  saveStacksConfig(path, config);
  assert.deepEqual(loadStacksConfig(path), config);
});

test("loadProjectStacks: absent or empty is undefined, malformed throws", () => {
  const cwd = join(tmp, "project");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  assert.equal(loadProjectStacks(cwd), undefined);
  writeFileSync(join(cwd, ".pi", "skill-stacks.json"), JSON.stringify({ stacks: {} }));
  assert.equal(loadProjectStacks(cwd), undefined);
  writeFileSync(join(cwd, ".pi", "skill-stacks.json"), JSON.stringify({ stacks: { p: ["x"] } }));
  assert.deepEqual(loadProjectStacks(cwd), { p: ["x"] });
  writeFileSync(join(cwd, ".pi", "skill-stacks.json"), JSON.stringify({ stacks: [] }));
  assert.throws(() => loadProjectStacks(cwd), ConfigError);
});

test("updateSettingsSkills: rewrites only the skills array, preserves other keys, no trailing newline", () => {
  const path = join(tmp, "settings.json");
  writeFileSync(path, JSON.stringify({ theme: "dark", skills: ["old"] }, null, 2));
  updateSettingsSkills(path, ["!skills/a/SKILL.md"]);
  const text = readFileSync(path, "utf-8");
  const parsed = JSON.parse(text);
  assert.equal(parsed.theme, "dark");
  assert.deepEqual(parsed.skills, ["!skills/a/SKILL.md"]);
  assert.ok(!text.endsWith("\n"));
});

test("updateSettingsSkills: refuses to overwrite a settings file it cannot parse", () => {
  const path = join(tmp, "corrupt-settings.json");
  writeFileSync(path, '{ "theme": "dark", ');
  assert.throws(() => updateSettingsSkills(path, []), ConfigError);
  assert.equal(readFileSync(path, "utf-8"), '{ "theme": "dark", ');
  assert.throws(() => readSettingsSkills(path), ConfigError);
});
