// File I/O for skill stacks: the extension's own config, skill discovery on
// disk, and surgical edits to the settings.json `skills` array.
//
// Global config lives at <agentDir>/skill-stacks.json. A project may add or
// override stack definitions in <cwd>/.pi/skill-stacks.json (stacks only;
// on/off state and managed exclusions stay global).
//
// Malformed files throw a ConfigError rather than degrading to an empty
// config: every load here sits in front of a write, and defaulting would let
// one bad entry erase the user's stacks or settings.
//
// Editing settings.json directly is safe alongside pi: SettingsManager
// persists with a read-modify-write that only touches fields modified through
// its own setters, so an external `skills` change survives unless the user
// also edits skills via `pi config` in the same session.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import {
  mergeStacks,
  summarizeStacks,
  type DiscoveredSkills,
  type StackMap,
} from "./core.ts";

export interface StacksConfig {
  stacks: StackMap;
  disabledStacks: string[];
  managedExclusions: string[];
}

/** A skill root plus the baseDir pi matches exclusion patterns against (its parent). */
export interface SkillRoot {
  dir: string;
  baseDir: string;
}

export class ConfigError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "ConfigError";
  }
}

/** Same lookup as pi's getAgentDir(): PI_CODING_AGENT_DIR override, else ~/.pi/agent. */
export function agentDir() {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
  return join(homedir(), ".pi", "agent");
}

export const globalConfigPath = () => join(agentDir(), "skill-stacks.json");
export const globalSettingsPath = () => join(agentDir(), "settings.json");
export const projectConfigPath = (cwd: string) => join(cwd, ".pi", "skill-stacks.json");

/** The skill roots this extension manages, with the baseDir patterns are relative to. */
export function defaultSkillRoots(): SkillRoot[] {
  const agents = join(homedir(), ".agents");
  return [
    { dir: join(agents, "skills"), baseDir: agents },
    { dir: join(agentDir(), "skills"), baseDir: agentDir() },
  ];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseStackMap(path: string, value: unknown): StackMap {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError(path, "`stacks` must be an object of name → skill names");
  const stacks: StackMap = {};
  for (const [name, skills] of Object.entries(value)) {
    if (!isStringArray(skills)) {
      throw new ConfigError(path, `stack "${name}" must be an array of skill names`);
    }
    stacks[name] = skills;
  }
  return stacks;
}

function parseNameList(path: string, key: string, value: unknown) {
  if (value === undefined) return [];
  if (!isStringArray(value)) throw new ConfigError(path, `\`${key}\` must be an array of strings`);
  return value;
}

/** Parsed JSON, undefined when the file is absent. Throws ConfigError on unreadable JSON. */
function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new ConfigError(path, `not valid JSON (${error instanceof Error ? error.message : error})`);
  }
}

function readJsonObject(path: string) {
  const raw = readJson(path);
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ConfigError(path, "top level must be a JSON object");
  return raw;
}

export function loadStacksConfig(path = globalConfigPath()): StacksConfig {
  const record = readJsonObject(path);
  if (!record) return { stacks: {}, disabledStacks: [], managedExclusions: [] };
  // disabledStacks/managedExclusions are kept even when stacks is empty: the
  // user may run only project-defined stacks, and their on/off state lives here.
  return {
    stacks: parseStackMap(path, record.stacks),
    disabledStacks: parseNameList(path, "disabledStacks", record.disabledStacks),
    managedExclusions: parseNameList(path, "managedExclusions", record.managedExclusions),
  };
}

export function saveStacksConfig(path: string, config: StacksConfig) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** Stack definitions from <cwd>/.pi/skill-stacks.json, or undefined when absent or empty. */
export function loadProjectStacks(cwd: string) {
  const path = projectConfigPath(cwd);
  const record = readJsonObject(path);
  if (!record) return undefined;
  const stacks = parseStackMap(path, record.stacks);
  return Object.keys(stacks).length > 0 ? stacks : undefined;
}

const toPosix = (path: string) => (sep === "/" ? path : path.split(sep).join("/"));

/** `name:` from YAML frontmatter, if present; pi falls back to the directory name. */
function frontmatterName(skillFile: string) {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skillFile, "utf-8"));
    const nameLine = match?.[1].split(/\r?\n/).find((line) => /^name\s*:/.test(line));
    const name = nameLine?.replace(/^name\s*:\s*/, "").trim().replace(/^["']|["']$/g, "");
    return name || undefined;
  } catch {
    return undefined;
  }
}

// Mirrors pi's loadSkillsFromDir: a directory with SKILL.md is a skill and is
// not recursed into; otherwise recurse, skipping dot-dirs and node_modules and
// following symlinks. Broken symlinks are skipped.
function collectSkills(dir: string, baseDir: string, into: Map<string, string>) {
  const entries = readDirEntries(dir);
  const skillFile = join(dir, "SKILL.md");
  if (entries.some((entry) => entry.name === "SKILL.md") && isFile(skillFile)) {
    const name = frontmatterName(skillFile) ?? basename(dir);
    if (!into.has(name)) into.set(name, toPosix(relative(baseDir, skillFile)));
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full))) {
      collectSkills(full, baseDir, into);
    }
  }
}

function readDirEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every skill pi would discover under the given roots, as name → baseDir-relative
 * SKILL.md path (the form exclusion patterns take). First root wins on a name
 * clash, matching pi's "keep the first one found" rule. Missing roots are skipped.
 */
export function discoverSkills(roots: SkillRoot[] = defaultSkillRoots()): DiscoveredSkills {
  const skills = new Map<string, string>();
  for (const root of roots) {
    if (existsSync(root.dir)) collectSkills(root.dir, root.baseDir, skills);
  }
  return skills;
}

/**
 * Full SKILL.md text per discovered skill, for the overlay's viewer pane.
 * Roots are tried in discovery order, so a name clash resolves the same way
 * discovery did. Unreadable skills map to "".
 */
export function readSkillContents(
  discovered: DiscoveredSkills,
  roots: SkillRoot[] = defaultSkillRoots(),
): Map<string, string> {
  const contents = new Map<string, string>();
  const done = new Set<string>();
  for (const root of roots) {
    for (const [name, relativePath] of discovered) {
      if (done.has(name)) continue;
      const full = join(root.baseDir, relativePath);
      if (isFile(full)) {
        contents.set(name, readFileSync(full, "utf-8"));
        done.add(name);
      }
    }
  }
  return contents;
}

export function readSettingsSkills(path = globalSettingsPath()) {
  const record = readJsonObject(path);
  const skills = record?.skills;
  if (skills !== undefined && !isStringArray(skills)) {
    throw new ConfigError(path, "`skills` must be an array of strings");
  }
  return skills ?? [];
}

/**
 * Replace the `skills` array in settings.json, leaving every other key as-is.
 * Written without a trailing newline to match pi's own SettingsManager output,
 * so a subsequent pi save doesn't produce a spurious diff.
 */
export function updateSettingsSkills(path: string, skills: string[]) {
  const settings = readJsonObject(path) ?? {};
  settings.skills = skills;
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Fresh-from-disk stacks summary for external consumers (e.g. a user's own
 * header extension). Not used by the package itself.
 * Returns undefined when no stacks are configured. Throws ConfigError on
 * malformed config; callers decide whether to fall back.
 */
export function loadStacksSummary(cwd: string) {
  const global = loadStacksConfig();
  const stacks = mergeStacks(global.stacks, loadProjectStacks(cwd));
  if (Object.keys(stacks).length === 0) return undefined;
  return summarizeStacks(stacks, global.disabledStacks, discoverSkills());
}
