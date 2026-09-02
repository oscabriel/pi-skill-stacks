// Pure state machine behind the /stacks overlay: selection, scrolling, and
// the mutation operations (toggle stack on/off, move skills between stacks,
// create/delete stacks). No I/O and no TUI here — extensions/overlay.ts
// renders it and persists each mutation through a callback.
//
// The model holds the MERGED stack map (global + project). Project-defined
// stacks are visible and toggleable but their membership is read-only; edits
// to them would be shadowed by the project config on the next merge.

import { computeExcludedSkills, sortNames, type DiscoveredSkills, type StackMap } from "./core.ts";

export type OverlayFocus = "stacks" | "members";

export interface StacksOverlayInit {
  stacks: StackMap;
  disabledStacks: string[];
  discovered: DiscoveredSkills;
  projectStackNames?: ReadonlySet<string>;
}

export interface StackRow {
  name: string;
  enabled: boolean;
  project: boolean;
  /** Discovered members only. */
  found: number;
  total: number;
}

export interface MemberRow {
  name: string;
  /** In the stack definition but not on disk. */
  missing: boolean;
  /** False when the skill is currently excluded (no enabled stack has it). */
  active: boolean;
}

export interface AvailableRow {
  name: string;
  /** Other stacks that also contain this skill. */
  otherStacks: string[];
}

export interface Window<T> {
  start: number;
  items: T[];
}

export type MembershipChange = "added" | "removed" | "blocked";
export type DeleteResult = "deleted" | "blocked" | "none";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Scroll offset that keeps `index` inside a window of `rows` starting at `offset`. */
function followIndex(offset: number, index: number, rows: number) {
  const visible = Math.max(1, rows);
  if (index < offset) return index;
  if (index >= offset + visible) return index - visible + 1;
  return offset;
}

export class StacksOverlayModel {
  focus: OverlayFocus = "stacks";
  stackIndex = 0;
  private stackOffset = 0;
  memberIndex = 0;
  private memberOffset = 0;
  private availableOffset = 0;

  private readonly discovered: DiscoveredSkills;
  private readonly projectStackNames: ReadonlySet<string>;
  private stackMap: StackMap;
  private names: string[];
  private disabled: Set<string>;
  private excluded: Set<string>;

  constructor(init: StacksOverlayInit) {
    this.discovered = init.discovered;
    this.projectStackNames = init.projectStackNames ?? new Set();
    this.stackMap = copyStacks(init.stacks);
    this.names = sortNames(Object.keys(this.stackMap));
    this.disabled = new Set(init.disabledStacks.filter((name) => this.names.includes(name)));
    this.excluded = computeExcludedSkills(this.stackMap, [...this.disabled]);
  }

  // ---- state accessors ----

  get stackCount() {
    return this.names.length;
  }

  get selectedStack(): string | undefined {
    return this.names[this.stackIndex];
  }

  /** Discovered skills that are not excluded right now. */
  get activeSkillCount() {
    let count = 0;
    for (const name of this.discovered.keys()) if (!this.excluded.has(name)) count += 1;
    return count;
  }

  get discoveredCount() {
    return this.discovered.size;
  }

  stackList() {
    return [...this.names];
  }

  isDisabled(name: string) {
    return this.disabled.has(name);
  }

  isProjectStack(name: string) {
    return this.projectStackNames.has(name);
  }

  membersOf(name: string) {
    return sortNames(this.stackMap[name] ?? []);
  }

  /** Discovered skills not in the given stack, sorted. */
  availableFor(name: string) {
    const members = new Set(this.stackMap[name] ?? []);
    return sortNames([...this.discovered.keys()].filter((skill) => !members.has(skill)));
  }

  isActiveSkill(name: string) {
    return !this.excluded.has(name);
  }

  /** Deep copy for persistence; disabled list sorted for stable config output. */
  snapshot() {
    return { stacks: copyStacks(this.stackMap), disabledStacks: sortNames(this.disabled) };
  }

  // ---- navigation ----

  setFocus(focus: OverlayFocus) {
    this.focus = focus;
  }

  moveStack(delta: number, rows: number) {
    if (this.names.length === 0) return;
    this.stackIndex = clamp(this.stackIndex + delta, 0, this.names.length - 1);
    this.stackOffset = followIndex(this.stackOffset, this.stackIndex, rows);
  }

  /** Flat movement across the members list then the available list. */
  moveMember(delta: number, memberRows: number, availableRows: number) {
    const total = this.flatMemberCount();
    if (total === 0) return;
    this.memberIndex = clamp(this.memberIndex + delta, 0, total - 1);
    const memberCount = this.selectedMembers.length;
    if (this.memberIndex < memberCount) {
      this.memberOffset = followIndex(this.memberOffset, this.memberIndex, memberRows);
    } else {
      const index = this.memberIndex - memberCount;
      this.availableOffset = followIndex(this.availableOffset, index, availableRows);
    }
  }

  // ---- windows for rendering ----

  stackWindow(rows: number): Window<StackRow> {
    const visible = Math.max(1, rows);
    const start = clamp(this.stackOffset, 0, Math.max(0, this.names.length - visible));
    return {
      start,
      items: this.names.slice(start, start + visible).map((name) => this.stackRow(name)),
    };
  }

  stackRow(name: string): StackRow {
    const members = this.stackMap[name] ?? [];
    return {
      name,
      enabled: !this.disabled.has(name),
      project: this.projectStackNames.has(name),
      found: members.filter((skill) => this.discovered.has(skill)).length,
      total: members.length,
    };
  }

  memberWindow(rows: number): Window<MemberRow> {
    const visible = Math.max(1, rows);
    const start = clamp(this.memberOffset, 0, Math.max(0, this.selectedMembers.length - visible));
    return {
      start,
      items: this.selectedMembers.slice(start, start + visible).map((name) => ({
        name,
        missing: !this.discovered.has(name),
        active: this.isActiveSkill(name),
      })),
    };
  }

  availableWindow(rows: number): Window<AvailableRow> {
    const available = this.selectedAvailable;
    const visible = Math.max(1, rows);
    const start = clamp(this.availableOffset, 0, Math.max(0, available.length - visible));
    return {
      start,
      items: available.slice(start, start + visible).map((name) => ({
        name,
        otherStacks: sortNames(
          Object.entries(this.stackMap)
            .filter(([stack, skills]) => stack !== this.selectedStack && skills.includes(name))
            .map(([stack]) => stack),
        ),
      })),
    };
  }

  // ---- mutations (each leaves the model consistent; caller persists) ----

  /** Flip the selected stack on/off. Always changes state. */
  toggleStack() {
    const name = this.selectedStack;
    if (!name) return false;
    if (this.disabled.has(name)) this.disabled.delete(name);
    else this.disabled.add(name);
    this.recomputeExcluded();
    return true;
  }

  /**
   * Space on a member row removes the skill from the selected stack; on an
   * available row it adds it. Blocked for project-defined stacks.
   */
  toggleMembership(): MembershipChange {
    const stack = this.selectedStack;
    if (!stack || this.projectStackNames.has(stack)) return "blocked";
    const memberCount = this.selectedMembers.length;
    if (this.memberIndex < memberCount) {
      const skill = this.selectedMembers[this.memberIndex]!;
      this.stackMap[stack] = (this.stackMap[stack] ?? []).filter((entry) => entry !== skill);
      this.afterMembershipChange();
      return "removed";
    }
    const skill = this.selectedAvailable[this.memberIndex - memberCount];
    if (!skill) return "blocked";
    this.stackMap[stack] = [...(this.stackMap[stack] ?? []), skill];
    this.afterMembershipChange();
    return "added";
  }

  /** Create an empty stack and select it. False when the name is taken. */
  createStack(name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed in this.stackMap) return false;
    this.stackMap[trimmed] = [];
    this.names = sortNames(Object.keys(this.stackMap));
    this.stackIndex = this.names.indexOf(trimmed);
    this.stackOffset = followIndex(this.stackOffset, this.stackIndex, 1);
    this.resetMemberCursor();
    return true;
  }

  /** Remove the selected stack's definition (and any disabled entry). */
  deleteSelectedStack(): DeleteResult {
    const name = this.selectedStack;
    if (!name) return "none";
    if (this.projectStackNames.has(name)) return "blocked";
    delete this.stackMap[name];
    this.names = sortNames(Object.keys(this.stackMap));
    this.disabled.delete(name);
    this.stackIndex = clamp(this.stackIndex, 0, Math.max(0, this.names.length - 1));
    this.resetMemberCursor();
    this.recomputeExcluded();
    return "deleted";
  }

  // ---- internals ----

  private get selectedMembers() {
    const stack = this.selectedStack;
    return stack ? this.membersOf(stack) : [];
  }

  private get selectedAvailable() {
    const stack = this.selectedStack;
    return stack ? this.availableFor(stack) : [];
  }

  private flatMemberCount() {
    return this.selectedMembers.length + this.selectedAvailable.length;
  }

  private recomputeExcluded() {
    this.excluded = computeExcludedSkills(this.stackMap, [...this.disabled]);
  }

  private afterMembershipChange() {
    this.recomputeExcluded();
    this.memberIndex = clamp(this.memberIndex, 0, Math.max(0, this.flatMemberCount() - 1));
  }

  private resetMemberCursor() {
    this.memberIndex = 0;
    this.memberOffset = 0;
    this.availableOffset = 0;
  }
}

const copyStacks = (stacks: StackMap): StackMap =>
  Object.fromEntries(Object.entries(stacks).map(([name, skills]) => [name, [...skills]]));
