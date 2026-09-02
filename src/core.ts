// Pure logic for skill stacks: merging stack definitions, deciding which
// skills get excluded, and diffing the settings.json `skills` array without
// touching entries the user wrote by hand.
//
// Mechanism (pi core, dist/core/package-manager.js `isEnabledByOverrides`):
// entries in the settings `skills` array that start with `!` exclude
// auto-discovered skills. Patterns are matched relative to the discovery
// baseDir, so `!skills/<dir>/SKILL.md` excludes `~/.agents/skills/<dir>/`
// (baseDir `~/.agents`) and `~/.pi/agent/skills/<dir>/` (baseDir
// `~/.pi/agent`) alike. Nested skills get their full relative path.

export type StackMap = Record<string, string[]>;

/**
 * Skill name → SKILL.md path relative to the discovery baseDir, e.g.
 * `skills/firecrawl-map/SKILL.md` or `skills/group/nested/SKILL.md`.
 */
export type DiscoveredSkills = ReadonlyMap<string, string>;

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
  /** Per-stack status in definition order. */
  stacks: StackStatus[];
}

export const sortNames = (names: Iterable<string>) =>
  [...names].sort((a, b) => a.localeCompare(b));

/** Project stacks add to the global set; a same-named project stack replaces the global one. */
export const mergeStacks = (global: StackMap, project: StackMap | undefined): StackMap => ({
  ...global,
  ...(project ?? {}),
});

/** Stack members that don't resolve to a discovered skill, keyed by stack. Empty stacks are omitted. */
export function missingSkillNames(stacks: StackMap, discovered: DiscoveredSkills) {
  const missing: Record<string, string[]> = {};
  for (const [stack, skills] of Object.entries(stacks)) {
    const absent = skills.filter((name) => !discovered.has(name));
    if (absent.length > 0) missing[stack] = absent;
  }
  return missing;
}

/**
 * A skill is excluded iff it appears in at least one stack and no enabled
 * stack contains it. Skills in no stack are never excluded.
 */
export function computeExcludedSkills(stacks: StackMap, disabledStacks: string[]) {
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

/** `!skills/<...>/SKILL.md` for a baseDir-relative skill path. */
export const exclusionPatternFor = (relativeSkillPath: string) => `!${relativeSkillPath}`;

/** Exclusion patterns for the excluded skills we can resolve on disk, sorted for stable output. */
export function desiredExclusions(
  stacks: StackMap,
  disabledStacks: string[],
  discovered: DiscoveredSkills,
) {
  const patterns: string[] = [];
  for (const name of computeExcludedSkills(stacks, disabledStacks)) {
    const path = discovered.get(name);
    if (path) patterns.push(exclusionPatternFor(path));
  }
  return patterns.sort((a, b) => a.localeCompare(b));
}

/**
 * Split previously managed exclusions into the ones this persist may rewrite
 * and the ones it must leave alone. An exclusion is out of scope when its
 * skill is on disk but in none of the stacks visible here: it belongs to a
 * stack we can't see (a project stack from another cwd), and "skills in no
 * stack are never touched" applies. Patterns for skills that no longer exist
 * stay in scope so they get cleaned up.
 */
export function scopeManagedExclusions(
  managed: string[],
  stacks: StackMap,
  discovered: DiscoveredSkills,
) {
  const visibleSkills = new Set(Object.values(stacks).flat());
  const nameByPattern = new Map<string, string>();
  for (const [name, path] of discovered) nameByPattern.set(exclusionPatternFor(path), name);
  const inScope: string[] = [];
  const retained: string[] = [];
  for (const pattern of managed) {
    const name = nameByPattern.get(pattern);
    if (name !== undefined && !visibleSkills.has(name)) retained.push(pattern);
    else inScope.push(pattern);
  }
  return { inScope, retained };
}

/**
 * Diff the settings `skills` array: drop the exclusions we wrote previously,
 * append the desired ones, and never touch or claim user-written entries.
 */
export function planSkillsSetting(
  currentSkills: string[],
  managedExclusions: string[],
  desired: string[],
): SkillsSettingPlan {
  const previouslyManaged = new Set(managedExclusions);
  const kept = currentSkills.filter((entry) => !previouslyManaged.has(entry));
  const keptSet = new Set(kept);
  const skills = [...kept];
  const managed: string[] = [];
  for (const pattern of desired) {
    if (keptSet.has(pattern)) continue; // user wrote it by hand; not ours
    skills.push(pattern);
    managed.push(pattern);
  }
  return { skills, managed };
}

/**
 * The global `disabledStacks` list after a persist. Entries for stacks that
 * were visible here are replaced by `visibleDisabled`; entries for stacks we
 * can't see (project stacks from another cwd) are preserved so their on/off
 * state survives toggling from elsewhere.
 */
export function nextDisabledStacks(
  globalDisabled: string[],
  visibleStackNames: Iterable<string>,
  visibleDisabled: string[],
) {
  const visible = new Set(visibleStackNames);
  const unseen = globalDisabled.filter((name) => !visible.has(name));
  return sortNames(new Set([...unseen, ...visibleDisabled]));
}

/** Stack and active-skill counts. Only discovered skills are counted. */
export function summarizeStacks(
  stacks: StackMap,
  disabledStacks: string[],
  discovered: DiscoveredSkills,
): StacksSummary {
  const stackNames = Object.keys(stacks);
  const excluded = computeExcludedSkills(stacks, disabledStacks);
  let activeCount = 0;
  for (const name of discovered.keys()) {
    if (!excluded.has(name)) activeCount += 1;
  }
  const disabled = new Set(disabledStacks);
  return {
    stackCount: stackNames.length,
    offStacks: disabledStacks.filter((name) => stackNames.includes(name)),
    totalCount: discovered.size,
    activeCount,
    stacks: Object.entries(stacks).map(([name, skills]) => ({
      name,
      size: skills.filter((skill) => discovered.has(skill)).length,
      enabled: !disabled.has(name),
    })),
  };
}
