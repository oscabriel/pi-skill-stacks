// Pure logic for skill stacks: merging stack definitions, deciding which
// skills get excluded, and diffing the settings.json `skills` array without
// touching entries the user wrote by hand.
//
// Mechanism (pi core, dist/core/package-manager.js `isEnabledByOverrides`):
// entries in the settings `skills` array that start with `!` exclude
// auto-discovered skills. Patterns are matched relative to the discovery
// baseDir, so `!skills/<name>/SKILL.md` excludes `~/.agents/skills/<name>/`
// (baseDir `~/.agents`) and `~/.pi/agent/skills/<name>/` (baseDir
// `~/.pi/agent`) alike.

export type StackMap = Record<string, string[]>;

export interface SkillsSettingPlan {
  /** The new value for the settings.json `skills` array. */
  skills: string[];
  /** The exclusion patterns this extension now owns (subset of `skills`). */
  managed: string[];
}

export interface StackStatus {
  name: string;
  /** Discovered members only; names that resolve to no skill dir are not counted. */
  size: number;
  enabled: boolean;
}

export interface StacksSummary {
  stackCount: number;
  offStacks: string[];
  totalCount: number;
  activeCount: number;
  /** Per-stack status in definition order, for the header section body. */
  stacks: StackStatus[];
}

/** Project stacks add to the global set; a same-named project stack replaces the global one. */
export function mergeStacks(global: StackMap, project: StackMap | undefined): StackMap {
  return { ...global, ...(project ?? {}) };
}

/** Stack members that don't resolve to a discovered skill, keyed by stack. Empty stacks are omitted. */
export function missingSkillNames(
  stacks: StackMap,
  discoveredNames: ReadonlySet<string>,
): Record<string, string[]> {
  const missing: Record<string, string[]> = {};
  for (const [stack, skills] of Object.entries(stacks)) {
    const absent = skills.filter((name) => !discoveredNames.has(name));
    if (absent.length > 0) missing[stack] = absent;
  }
  return missing;
}

/**
 * A skill is excluded iff it appears in at least one stack and no enabled
 * stack contains it. Skills in no stack are never excluded.
 */
export function computeExcludedSkills(stacks: StackMap, disabledStacks: string[]): Set<string> {
  const disabled = new Set(disabledStacks);
  const keptByEnabledStack = new Set<string>();
  const inSomeStack = new Set<string>();
  for (const [stack, skills] of Object.entries(stacks)) {
    for (const name of skills) {
      inSomeStack.add(name);
      if (!disabled.has(stack)) keptByEnabledStack.add(name);
    }
  }
  const excluded = new Set<string>();
  for (const name of inSomeStack) {
    if (!keptByEnabledStack.has(name)) excluded.add(name);
  }
  return excluded;
}

export function exclusionPatternFor(skillName: string): string {
  return `!skills/${skillName}/SKILL.md`;
}

/**
 * Diff the settings `skills` array: drop the exclusions we wrote previously,
 * append the desired ones, and never touch or claim user-written entries.
 */
export function planSkillsSetting(
  currentSkills: string[],
  managedExclusions: string[],
  desiredExclusions: string[],
): SkillsSettingPlan {
  const previouslyManaged = new Set(managedExclusions);
  const kept = currentSkills.filter((entry) => !previouslyManaged.has(entry));
  const keptSet = new Set(kept);
  const skills = [...kept];
  const managed: string[] = [];
  for (const pattern of desiredExclusions) {
    if (keptSet.has(pattern)) continue; // user wrote it by hand; not ours
    skills.push(pattern);
    managed.push(pattern);
  }
  return { skills, managed };
}

/** Counts for the compact `[Skills]` header line. Only discovered skills are counted. */
export function summarizeStacks(
  stacks: StackMap,
  disabledStacks: string[],
  discoveredNames: ReadonlySet<string>,
): StacksSummary {
  const stackNames = Object.keys(stacks);
  const excluded = computeExcludedSkills(stacks, disabledStacks);
  let activeCount = 0;
  for (const name of discoveredNames) {
    if (!excluded.has(name)) activeCount += 1;
  }
  const disabled = new Set(disabledStacks);
  const stackStatuses = Object.entries(stacks).map(([name, skills]) => ({
    name,
    size: skills.filter((skill) => discoveredNames.has(skill)).length,
    enabled: !disabled.has(name),
  }));
  return {
    stackCount: stackNames.length,
    offStacks: disabledStacks.filter((name) => stackNames.includes(name)),
    totalCount: discoveredNames.size,
    activeCount,
    stacks: stackStatuses,
  };
}
