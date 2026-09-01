/**
 * skill-stacks - Toggle named groups of skills on/off for context management.
 *
 * - `/stacks` opens a picker: space flips a stack, enter applies once, esc cancels
 * - `/stacks on <stack>` / `/stacks off <stack>` toggle a single stack
 * - `/stacks list` prints the current state without changing anything
 *
 * Toggling off writes `!skills/<name>/SKILL.md` exclusion patterns into the
 * global settings `skills` array (pi's own override mechanism), so disabled
 * skills vanish from the system prompt, `/skill:` commands, and discovery.
 * Every apply ends with ctx.reload(). The extension only ever removes
 * exclusions it wrote itself (tracked in skill-stacks.json managedExclusions);
 * hand-written `pi config` entries are left alone.
 *
 * Config: global stacks + state in ~/.pi/agent/skill-stacks.json; a project
 * may add/override stack definitions in <cwd>/.pi/skill-stacks.json.
 * Overlap rule: a skill stays enabled if any enabled stack contains it.
 * Skills in no stack are never touched.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  computeExcludedSkills,
  exclusionPatternFor,
  mergeStacks,
  missingSkillNames,
  planSkillsSetting,
  summarizeStacks,
  type StackMap,
  type StacksSummary,
} from "../src/core.ts";
import {
  discoverSkillNames,
  globalConfigPath,
  globalSettingsPath,
  loadProjectStacks,
  loadStacksConfig,
  readSettingsSkills,
  saveStacksConfig,
  updateSettingsSkills,
} from "../src/store.ts";

interface StacksView {
  stacks: StackMap;
  stackNames: string[];
  disabledStacks: string[];
  discovered: Set<string>;
}

function loadView(cwd: string): StacksView {
  const global = loadStacksConfig();
  const stacks = mergeStacks(global.stacks, loadProjectStacks(cwd));
  const stackNames = Object.keys(stacks).sort((a, b) => a.localeCompare(b));
  const disabledStacks = global.disabledStacks.filter((name) => stackNames.includes(name));
  return { stacks, stackNames, disabledStacks, discovered: discoverSkillNames() };
}

interface ApplyOutcome {
  summary: StacksSummary;
  missing: Record<string, string[]>;
  settingsChanged: boolean;
}

/** Persist a new disabled-stack set: settings.json exclusions + skill-stacks.json state. */
function applyDisabledStacks(view: StacksView, disabledStacks: string[]): ApplyOutcome {
  const global = loadStacksConfig();
  const excluded = computeExcludedSkills(view.stacks, disabledStacks);
  const desired = [...excluded]
    .filter((name) => view.discovered.has(name))
    .sort((a, b) => a.localeCompare(b))
    .map(exclusionPatternFor);

  const current = readSettingsSkills();
  const plan = planSkillsSetting(current, global.managedExclusions, desired);
  const settingsChanged =
    plan.skills.length !== current.length || plan.skills.some((entry, i) => entry !== current[i]);
  if (settingsChanged) {
    updateSettingsSkills(globalSettingsPath(), plan.skills);
  }
  saveStacksConfig(globalConfigPath(), {
    stacks: global.stacks,
    disabledStacks,
    managedExclusions: plan.managed,
  });

  return {
    summary: summarizeStacks(view.stacks, disabledStacks, view.discovered),
    missing: missingSkillNames(view.stacks, view.discovered),
    settingsChanged,
  };
}

function formatSummary(summary: StacksSummary): string {
  const off = summary.offStacks.length > 0 ? ` · off: ${summary.offStacks.join(", ")}` : "";
  return `${summary.stackCount} stacks · ${summary.activeCount}/${summary.totalCount} skills active${off}`;
}

async function finishApply(
  ctx: ExtensionCommandContext,
  view: StacksView,
  disabledStacks: string[],
): Promise<void> {
  const outcome = applyDisabledStacks(view, disabledStacks);
  const missingEntries = Object.entries(outcome.missing);
  if (missingEntries.length > 0) {
    const detail = missingEntries
      .map(([stack, names]) => `${stack}: ${names.join(", ")}`)
      .join("; ");
    ctx.ui.notify(`Stacks reference unknown skills (${detail})`, "warning");
  }
  ctx.ui.notify(formatSummary(outcome.summary), "info");
  await ctx.reload();
}

async function pickStacks(
  ctx: ExtensionCommandContext,
  view: StacksView,
): Promise<string[] | null> {
  if (ctx.mode !== "tui") return null;

  return await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
    let row = 0;
    const disabled = new Set(view.disabledStacks);
    let cachedLines: string[] | undefined;
    let cachedWidth = -1;

    function refresh() {
      cachedLines = undefined;
      cachedWidth = -1;
      tui.requestRender();
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.up)) {
        row = (row - 1 + view.stackNames.length) % view.stackNames.length;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        row = (row + 1) % view.stackNames.length;
        refresh();
        return;
      }
      if (data === " ") {
        const name = view.stackNames[row];
        if (disabled.has(name)) disabled.delete(name);
        else disabled.add(name);
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        done([...disabled].sort((a, b) => a.localeCompare(b)));
        return;
      }
      if (matchesKey(data, Key.escape)) {
        done(null);
      }
    }

    function render(width: number): string[] {
      if (cachedLines && cachedWidth === width) return cachedLines;
      const lines: string[] = [];
      const add = (s: string) => lines.push(truncateToWidth(s, width));

      const title = " Skill stacks ";
      add(theme.fg("accent", `─${title}${"─".repeat(Math.max(0, width - title.length - 1))}`));
      for (let i = 0; i < view.stackNames.length; i += 1) {
        const name = view.stackNames[i];
        const members = view.stacks[name] ?? [];
        const found = members.filter((skill) => view.discovered.has(skill)).length;
        const off = disabled.has(name);
        const box = off ? "[ ]" : "[x]";
        const count =
          found === members.length ? `${members.length} skills` : `${found}/${members.length} skills`;
        const prefix = i === row ? theme.fg("accent", " ❯ ") : "   ";
        const label = `${box} ${name}`;
        add(
          prefix +
            (i === row ? theme.fg("accent", label) : theme.fg(off ? "muted" : "text", label)) +
            theme.fg("dim", `  ${count}`),
        );
      }
      lines.push("");
      add(theme.fg("dim", " ↑↓ move · space toggle · enter apply · esc cancel"));
      add(theme.fg("accent", "─".repeat(width)));
      cachedLines = lines;
      cachedWidth = width;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
        cachedWidth = -1;
      },
      handleInput,
    };
  });
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry) => b.includes(entry));
}

export default function skillStacks(pi: ExtensionAPI) {
  pi.registerCommand("stacks", {
    description: "Toggle skill stacks on/off (picker, or: on|off <stack>, list)",
    getArgumentCompletions: (prefix: string) => {
      const view = loadView(process.cwd());
      const disabled = new Set(view.disabledStacks);
      let items: { value: string; label: string }[];
      if (prefix.startsWith("on ")) {
        items = view.stackNames
          .filter((name) => disabled.has(name))
          .map((name) => ({ value: `on ${name}`, label: name }));
      } else if (prefix.startsWith("off ")) {
        items = view.stackNames
          .filter((name) => !disabled.has(name))
          .map((name) => ({ value: `off ${name}`, label: name }));
      } else {
        items = [
          { value: "on", label: "on <stack> - enable a stack" },
          { value: "off", label: "off <stack> - disable a stack" },
          { value: "list", label: "list - show current state" },
        ];
      }
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      const view = loadView(ctx.cwd);
      if (view.stackNames.length === 0) {
        ctx.ui.notify(`No stacks configured. Define them in ${globalConfigPath()}`, "warning");
        return;
      }

      const trimmed = args.trim();
      if (trimmed === "") {
        const picked = await pickStacks(ctx, view);
        if (picked === null || sameMembers(picked, view.disabledStacks)) {
          ctx.ui.notify("Stacks unchanged", "info");
          return;
        }
        await finishApply(ctx, view, picked);
        return;
      }

      if (trimmed === "list") {
        const summary = summarizeStacks(view.stacks, view.disabledStacks, view.discovered);
        const rows = view.stackNames.map((name) => {
          const state = view.disabledStacks.includes(name) ? "off" : "on";
          return `${name}: ${state} (${(view.stacks[name] ?? []).length} skills)`;
        });
        ctx.ui.notify(`${formatSummary(summary)}\n${rows.join("\n")}`, "info");
        return;
      }

      const match = /^(on|off)\s+(\S+)$/.exec(trimmed);
      if (!match) {
        ctx.ui.notify("Usage: /stacks [on <stack> | off <stack> | list]", "warning");
        return;
      }
      const [, action, name] = match;
      if (!view.stackNames.includes(name)) {
        ctx.ui.notify(`Unknown stack "${name}". Stacks: ${view.stackNames.join(", ")}`, "warning");
        return;
      }
      const isOff = view.disabledStacks.includes(name);
      if ((action === "off") === isOff) {
        ctx.ui.notify(`Stack "${name}" is already ${isOff ? "off" : "on"}`, "info");
        return;
      }
      const next =
        action === "off"
          ? [...view.disabledStacks, name].sort((a, b) => a.localeCompare(b))
          : view.disabledStacks.filter((entry) => entry !== name);
      await finishApply(ctx, view, next);
    },
  });
}
