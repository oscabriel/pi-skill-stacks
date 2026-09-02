// Pure state machine behind the /stacks overlay: selection, scrolling, and
// the mutation operations (toggle stack on/off, move skills between stacks,
// create/delete stacks). No I/O and no TUI here — extensions/overlay.ts
// renders it and persists each mutation through a callback.
//
// The model holds the MERGED stack map (global + project). Project-defined
// stacks are visible and toggleable but their membership is read-only; edits
// to them would be shadowed by the project config on the next merge.

import { computeExcludedSkills, type StackMap } from "./core.ts";

export type OverlayFocus = "stacks" | "members";

export interface StacksOverlayInit {
  stacks: StackMap;
  disabledStacks: string[];
  discovered: ReadonlySet<string>;
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

function sorted(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class StacksOverlayModel {
  focus: OverlayFocus = "stacks";
  stackIndex = 0;
  private stackOffset = 0;
  memberIndex = 0;
  private memberOffset = 0;
  private availableOffset = 0;

  private readonly discovered: ReadonlySet<string>;
  private readonly projectStackNames: ReadonlySet<string>;
  private stackMap: StackMap;
  private names: string[];
  private disabled: Set<string>;
  private excludedCache: Set<string>;

  constructor(init: StacksOverlayInit) {
    this.discovered = init.discovered;
    this.projectStackNames = init.projectStackNames ?? new Set();
    this.stackMap = Object.fromEntries(
      Object.entries(init.stacks).map(([name, skills]) => [name, [...skills]]),
    );
    this.names = Object.keys(this.stackMap).sort((a, b) => a.localeCompare(b));
    this.disabled = new Set(init.disabledStacks.filter((name) => this.names.includes(name)));
    this.excludedCache = computeExcludedSkills(this.stackMap, [...this.disabled]);
    this.stackIndex = clamp(0, 0, Math.max(0, this.names.length - 1));
  }

  // ---- state accessors ----

  get stackCount(): number {
    return this.names.length;
  }

  get selectedStack(): string | undefined {
    return this.names[this.stackIndex];
  }

  stackList(): string[] {
    return [...this.names];
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  isProjectStack(name: string): boolean {
    return this.projectStackNames.has(name);
  }

  membersOf(name: string): string[] {
    return sorted(this.stackMap[name] ?? []);
  }

  /** Discovered skills not in the given stack, sorted. */
  availableFor(name: string): string[] {
    const members = new Set(this.stackMap[name] ?? []);
    return sorted([...this.discovered].filter((skill) => !members.has(skill)));
  }

  /** Skills currently excluded (in ≥1 stack, no enabled stack). */
  excludedSkills(): ReadonlySet<string> {
    return this.excludedCache;
  }

  isActiveSkill(name: string): boolean {
    return !this.excludedCache.has(name);
  }

  /** Deep copy for persistence; disabled list sorted for stable config output. */
  snapshot(): { stacks: StackMap; disabledStacks: string[] } {
    return {
      stacks: Object.fromEntries(
        Object.entries(this.stackMap).map(([name, skills]) => [name, [...skills]]),
      ),
      disabledStacks: sorted(this.disabled),
    };
  }

  // ---- navigation ----

  setFocus(focus: OverlayFocus): void {
    this.focus = focus;
  }

  moveStack(delta: number, rows: number): void {
    if (this.names.length === 0) return;
    this.stackIndex = clamp(this.stackIndex + delta, 0, this.names.length - 1);
    const visible = Math.max(1, rows);
    if (this.stackIndex < this.stackOffset) this.stackOffset = this.stackIndex;
    if (this.stackIndex >= this.stackOffset + visible) {
      this.stackOffset = this.stackIndex - visible + 1;
    }
  }

  /** Flat movement across the members list then the available list. */
  moveMember(delta: number, memberRows: number, availableRows: number): void {
    const total = this.flatMemberCount();
    if (total === 0) return;
    this.memberIndex = clamp(this.memberIndex + delta, 0, total - 1);
    const memberCount = this.selectedMembers.length;
    if (this.memberIndex < memberCount) {
      const visible = Math.max(1, memberRows);
      if (this.memberIndex < this.memberOffset) this.memberOffset = this.memberIndex;
      if (this.memberIndex >= this.memberOffset + visible) {
        this.memberOffset = this.memberIndex - visible + 1;
      }
    } else {
      const index = this.memberIndex - memberCount;
      const visible = Math.max(1, availableRows);
      if (index < this.availableOffset) this.availableOffset = index;
      if (index >= this.availableOffset + visible) {
        this.availableOffset = index - visible + 1;
      }
    }
  }

  // ---- windows for rendering ----

  stackWindow(rows: number): Window<StackRow> {
    const visible = Math.max(1, rows);
    const start = clamp(this.stackOffset, 0, Math.max(0, this.names.length - visible));
    return {
      start,
      items: this.names.slice(start, start + visible).map((name) => {
        const members = this.stackMap[name] ?? [];
        return {
          name,
          enabled: !this.disabled.has(name),
          project: this.projectStackNames.has(name),
          found: members.filter((skill) => this.discovered.has(skill)).length,
          total: members.length,
        };
      }),
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
        otherStacks: sorted(
          Object.entries(this.stackMap)
            .filter(([stack, skills]) => stack !== this.selectedStack && skills.includes(name))
            .map(([stack]) => stack),
        ),
      })),
    };
  }

  // ---- mutations (each leaves the model consistent; caller persists) ----

  /** Flip the selected stack on/off. Always changes state. */
  toggleStack(): boolean {
    const name = this.selectedStack;
    if (!name) return false;
    if (this.disabled.has(name)) this.disabled.delete(name);
    else this.disabled.add(name);
    this.excludedCache = computeExcludedSkills(this.stackMap, [...this.disabled]);
    return true;
  }

  /**
   * Space on a member row removes the skill from the selected stack; on an
   * available row it adds it. Blocked for project-defined stacks.
   */
  toggleMembership(): MembershipChange {
    const stack = this.selectedStack;
    if (!stack) return "blocked";
    if (this.projectStackNames.has(stack)) return "blocked";
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
  createStack(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed || trimmed in this.stackMap) return false;
    this.stackMap[trimmed] = [];
    this.names = Object.keys(this.stackMap).sort((a, b) => a.localeCompare(b));
    this.stackIndex = this.names.indexOf(trimmed);
    this.ensureStackVisible(1);
    this.memberIndex = 0;
    this.memberOffset = 0;
    this.availableOffset = 0;
    return true;
  }

  /** Remove the selected stack's definition (and any disabled entry). */
  deleteSelectedStack(): DeleteResult {
    const name = this.selectedStack;
    if (!name) return "none";
    if (this.projectStackNames.has(name)) return "blocked";
    delete this.stackMap[name];
    this.names = Object.keys(this.stackMap).sort((a, b) => a.localeCompare(b));
    this.disabled.delete(name);
    this.stackIndex = clamp(this.stackIndex, 0, Math.max(0, this.names.length - 1));
    this.memberIndex = 0;
    this.memberOffset = 0;
    this.availableOffset = 0;
    this.excludedCache = computeExcludedSkills(this.stackMap, [...this.disabled]);
    return "deleted";
  }

  // ---- internals ----

  private get selectedMembers(): string[] {
    const stack = this.selectedStack;
    return stack ? this.membersOf(stack) : [];
  }

  private get selectedAvailable(): string[] {
    const stack = this.selectedStack;
    return stack ? this.availableFor(stack) : [];
  }

  private flatMemberCount(): number {
    return this.selectedMembers.length + this.selectedAvailable.length;
  }

  private afterMembershipChange(): void {
    this.excludedCache = computeExcludedSkills(this.stackMap, [...this.disabled]);
    this.memberIndex = clamp(this.memberIndex, 0, Math.max(0, this.flatMemberCount() - 1));
  }

  private ensureStackVisible(rows: number): void {
    const visible = Math.max(1, rows);
    if (this.stackIndex < this.stackOffset) this.stackOffset = this.stackIndex;
    if (this.stackIndex >= this.stackOffset + visible) {
      this.stackOffset = this.stackIndex - visible + 1;
    }
  }
}
