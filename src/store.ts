// File I/O for skill stacks: the extension's own config, skill discovery on
// disk, and surgical edits to the settings.json `skills` array.
//
// Global config lives at <agentDir>/skill-stacks.json. A project may add or
// override stack definitions in <cwd>/.pi/skill-stacks.json (stacks only;
// on/off state and managed exclusions stay global).
//
// Editing settings.json directly is safe alongside pi: SettingsManager
// persists with a read-modify-write that only touches fields modified through
// its own setters, so an external `skills` change survives unless the user
// also edits skills via `pi config` in the same session.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  summarizeStacks,
  type StackMap,
  type StacksSummary,
} from "./core.ts";

export interface StacksConfig {
  stacks: StackMap;
  disabledStacks: string[];
  managedExclusions: string[];
}

/** Same lookup as pi's getAgentDir(): PI_CODING_AGENT_DIR override, else ~/.pi/agent. */
export function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
  return join(homedir(), ".pi", "agent");
}

export const globalConfigPath = () => join(agentDir(), "skill-stacks.json");
export const globalSettingsPath = () => join(agentDir(), "settings.json");

/** The skill roots this extension manages. Patterns are written relative to each root's parent. */
export function defaultSkillRoots(): string[] {
  return [join(homedir(), ".agents", "skills"), join(agentDir(), "skills")];
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "skill-stacks.json");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseStackMap(value: unknown): StackMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const stacks: StackMap = {};
  for (const [name, skills] of Object.entries(value)) {
    if (!isStringArray(skills)) return {};
    stacks[name] = skills;
  }
  return stacks;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

export function loadStacksConfig(path: string = globalConfigPath()): StacksConfig {
  const raw = readJson(path);
  if (typeof raw !== "object" || raw === null) {
    return { stacks: {}, disabledStacks: [], managedExclusions: [] };
  }
  const record = raw as Record<string, unknown>;
  const stacks = parseStackMap(record.stacks);
  const disabledStacks = isStringArray(record.disabledStacks) ? record.disabledStacks : [];
  const managedExclusions = isStringArray(record.managedExclusions) ? record.managedExclusions : [];
  if (Object.keys(stacks).length === 0) {
    return { stacks: {}, disabledStacks: [], managedExclusions: [] };
  }
  return { stacks, disabledStacks, managedExclusions };
}

export function saveStacksConfig(path: string, config: StacksConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** Stack definitions from <cwd>/.pi/skill-stacks.json, or undefined when absent/invalid. */
export function loadProjectStacks(cwd: string): StackMap | undefined {
  const raw = readJson(projectConfigPath(cwd));
  if (typeof raw !== "object" || raw === null) return undefined;
  const stacks = parseStackMap((raw as Record<string, unknown>).stacks);
  return Object.keys(stacks).length > 0 ? stacks : undefined;
}

/** Directory names containing a SKILL.md, across the given roots. Missing roots are skipped. */
export function discoverSkillNames(roots: string[] = defaultSkillRoots()): Set<string> {
  const names = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (existsSync(join(root, entry.name, "SKILL.md"))) names.add(entry.name);
    }
  }
  return names;
}

export function readSettingsSkills(path: string = globalSettingsPath()): string[] {
  const raw = readJson(path);
  if (typeof raw !== "object" || raw === null) return [];
  const skills = (raw as Record<string, unknown>).skills;
  return isStringArray(skills) ? skills : [];
}

/** Replace the `skills` array in settings.json, leaving every other key as-is. */
export function updateSettingsSkills(path: string, skills: string[]): void {
  const raw = readJson(path);
  const settings =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  settings.skills = skills;
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Fresh-from-disk summary for the compact `[Skills]` header line.
 * Returns undefined when no stacks are configured (leave pi's section alone).
 */
export function loadStacksSummary(cwd: string): StacksSummary | undefined {
  const global = loadStacksConfig();
  const project = loadProjectStacks(cwd);
  const stacks = { ...global.stacks, ...(project ?? {}) };
  if (Object.keys(stacks).length === 0) return undefined;
  return summarizeStacks(stacks, global.disabledStacks, discoverSkillNames());
}
