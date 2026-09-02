/**
 * skill-stacks - Toggle named groups of skills on/off for context management.
 *
 * - `/stacks` opens a two-pane overlay: toggle stacks on/off, move skills in
 *   and out of stacks, create/delete stacks. Changes persist immediately;
 *   pi reloads once when the overlay closes.
 * - `/stacks on <stack>` / `/stacks off <stack>` toggle a single stack
 * - `/stacks list` prints the current state without changing anything
 *
 * Toggling off writes `!skills/<name>/SKILL.md` exclusion patterns into the
 * global settings `skills` array (pi's own override mechanism), so disabled
 * skills vanish from the system prompt, `/skill:` commands, and discovery.
 * Every persist ends with the caller deciding when to ctx.reload(). The
 * extension only ever removes exclusions it wrote itself (tracked in
 * skill-stacks.json managedExclusions); hand-written `pi config` entries are
 * left alone.
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
import { showStacksOverlay, type ApplyOutcome } from "./overlay.ts";

interface StacksView {
  stacks: StackMap;
  stackNames: string[];
  disabledStacks: string[];
  discovered: Set<string>;
  /** Stack names defined in <cwd>/.pi/skill-stacks.json (membership is read-only in the overlay). */
  projectStackNames: Set<string>;
}

function loadView(cwd: string): StacksView {
  const global = loadStacksConfig();
  const project = loadProjectStacks(cwd);
  const stacks = mergeStacks(global.stacks, project);
  const stackNames = Object.keys(stacks).sort((a, b) => a.localeCompare(b));
  const disabledStacks = global.disabledStacks.filter((name) => stackNames.includes(name));
  return {
    stacks,
    stackNames,
    disabledStacks,
    discovered: discoverSkillNames(),
    projectStackNames: new Set(Object.keys(project ?? {})),
  };
}

/**
 * Persist a full stacks state: settings.json exclusions + skill-stacks.json.
 * Takes the MERGED stack map (global + project). Project-defined entries are
 * written back untouched; everything else comes from the (possibly edited)
 * merged map. Returns the outcome for notification; the caller decides when
 * to reload.
 */
function persistStacksState(
  stacks: StackMap,
  disabledStacks: string[],
  discovered: ReadonlySet<string>,
  projectStackNames: ReadonlySet<string>,
): ApplyOutcome {
  const global = loadStacksConfig();
  const globalStacks: StackMap = {};
  for (const [name, skills] of Object.entries(global.stacks)) {
    if (projectStackNames.has(name)) {
      globalStacks[name] = skills; // shadowed by the project; keep as-is
    } else if (name in stacks) {
      globalStacks[name] = stacks[name]!; // possibly edited
    } // else: deleted in the overlay
  }
  for (const [name, skills] of Object.entries(stacks)) {
    if (!projectStackNames.has(name) && !(name in globalStacks)) {
      globalStacks[name] = skills; // created in the overlay
    }
  }

  const excluded = computeExcludedSkills(stacks, disabledStacks);
  const desired = [...excluded]
    .filter((name) => discovered.has(name))
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
    stacks: globalStacks,
    disabledStacks,
    managedExclusions: plan.managed,
  });

  return {
    summary: summarizeStacks(stacks, disabledStacks, discovered),
    missing: missingSkillNames(stacks, discovered),
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
  const outcome = persistStacksState(view.stacks, disabledStacks, view.discovered, view.projectStackNames);
  notifyOutcome(ctx, outcome);
  await ctx.reload();
}

function notifyOutcome(ctx: ExtensionCommandContext, outcome: ApplyOutcome): void {
  const missingEntries = Object.entries(outcome.missing);
  if (missingEntries.length > 0) {
    const detail = missingEntries
      .map(([stack, names]) => `${stack}: ${names.join(", ")}`)
      .join("; ");
    ctx.ui.notify(`Stacks reference unknown skills (${detail})`, "warning");
  }
  ctx.ui.notify(formatSummary(outcome.summary), "info");
}

function listStacks(view: StacksView): string {
  const summary = summarizeStacks(view.stacks, view.disabledStacks, view.discovered);
  const rows = view.stackNames.map((name) => {
    const state = view.disabledStacks.includes(name) ? "off" : "on";
    return `${name}: ${state} (${(view.stacks[name] ?? []).length} skills)`;
  });
  return `${formatSummary(summary)}\n${rows.join("\n")}`;
}

export default function skillStacks(pi: ExtensionAPI) {
  pi.registerCommand("stacks", {
    description: "Open the stacks overlay (or: on|off <stack>, list)",
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
        if (ctx.mode !== "tui") {
          ctx.ui.notify(listStacks(view), "info");
          return;
        }
        const result = await showStacksOverlay(
          ctx,
          {
            stacks: view.stacks,
            disabledStacks: view.disabledStacks,
            discovered: view.discovered,
            projectStackNames: view.projectStackNames,
          },
          (stacks, disabledStacks) =>
            persistStacksState(stacks, disabledStacks, view.discovered, view.projectStackNames),
        );
        if (result.changed && result.outcome) {
          notifyOutcome(ctx, result.outcome);
          await ctx.reload();
        }
        return;
      }

      if (trimmed === "list") {
        ctx.ui.notify(listStacks(view), "info");
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
