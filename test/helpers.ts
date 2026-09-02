import type { DiscoveredSkills } from "../src/core.ts";

/** Discovered-skills map for names living directly under a `skills/` root. */
export const skillsOnDisk = (...names: string[]): DiscoveredSkills =>
  new Map(names.map((name) => [name, `skills/${name}/SKILL.md`]));
