/**
 * skill-stacks - Toggle named groups of skills on/off for context management.
 *
 * - `/stacks` opens a two-pane overlay: toggle stacks on/off, move skills in
 *   and out of stacks, create/delete stacks. Changes persist immediately;
 *   pi reloads once when the overlay closes, if settings.json changed.
 * - `/stacks on <stack>` / `/stacks off <stack>` toggle a single stack
 * - `/stacks list` prints the current state without changing anything
 *
 * Toggling off writes `!skills/<dir>/SKILL.md` exclusion patterns into the
 * global settings `skills` array (pi's own override mechanism), so disabled
 * skills vanish from the system prompt, `/skill:` commands, and discovery.
 * The extension only ever removes exclusions it wrote itself (tracked in
 * skill-stacks.json managedExclusions); hand-written `pi config` entries are
 * left alone.
 *
 * Config: global stacks + state in ~/.pi/agent/skill-stacks.json; a project
 * may add/override stack definitions in <cwd>/.pi/skill-stacks.json.
 * Overlap rule: a skill stays enabled if any enabled stack contains it.
 * Skills in no stack are never touched.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  desiredExclusions,
  mergeStacks,
  missingSkillNames,
  nextDisabledStacks,
  planSkillsSetting,
  scopeManagedExclusions,
  sortNames,
  summarizeStacks,
  type DiscoveredSkills,
  type StackMap,
  type StacksSummary,
} from "../src/core.ts";
import {
  ConfigError,
  discoverSkills,
  globalConfigPath,
  globalSettingsPath,
  loadProjectStacks,
  loadStacksConfig,
  readSettingsSkills,
  readSkillContents,
  saveStacksConfig,
  updateSettingsSkills,
} from "../src/store.ts";
import { showStacksOverlay, type ApplyOutcome } from "./overlay.ts";

/** Everything the command needs about the current cwd's merged stacks. */
interface StacksView {
  stacks: StackMap;
  stackNames: string[];
  /** Disabled entries for stacks visible here (the global list may hold more). */
  disabledStacks: string[];
  discovered: DiscoveredSkills;
  /** Stack names defined in <cwd>/.pi/skill-stacks.json (membership is read-only in the overlay). */
  projectStackNames: Set<string>;
}

function loadView(cwd: string): StacksView {
  const global = loadStacksConfig();
  const project = loadProjectStacks(cwd);
  const stacks = mergeStacks(global.stacks, project);
  const stackNames = sortNames(Object.keys(stacks));
  return {
    stacks,
    stackNames,
    disabledStacks: global.disabledStacks.filter((name) => stackNames.includes(name)),
    discovered: discoverSkills(),
    projectStackNames: new Set(Object.keys(project ?? {})),
  };
}

/**
 * Persist a full stacks state: settings.json exclusions + skill-stacks.json.
 * `stacks` is the MERGED map (global + project) as edited. Project-defined
 * entries are written back untouched; everything else comes from the merged
 * map. State for stacks not visible from this cwd (another project's stacks)
 * is preserved: their disabled entries and the exclusions written for them.
 * Returns the outcome for notification; the caller decides whether to reload.
 */
function persistStacksState(view: StacksView, stacks: StackMap, disabledStacks: string[]): ApplyOutcome {
  const global = loadStacksConfig();
  const { projectStackNames, discovered } = view;

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

  const { inScope, retained } = scopeManagedExclusions(global.managedExclusions, stacks, discovered);
  const current = readSettingsSkills();
  const plan = planSkillsSetting(current, inScope, desiredExclusions(stacks, disabledStacks, discovered));
  const settingsChanged =
    plan.skills.length !== current.length || plan.skills.some((entry, i) => entry !== current[i]);
  if (settingsChanged) updateSettingsSkills(globalSettingsPath(), plan.skills);

  const visibleNames = new Set([...view.stackNames, ...Object.keys(stacks)]);
  saveStacksConfig(globalConfigPath(), {
    stacks: globalStacks,
    disabledStacks: nextDisabledStacks(global.disabledStacks, visibleNames, disabledStacks),
    managedExclusions: sortNames([...retained.filter((p) => plan.skills.includes(p)), ...plan.managed]),
  });

  return { summary: summarizeStacks(stacks, disabledStacks, discovered), settingsChanged };
}

function formatSummary(summary: StacksSummary) {
  const off = summary.offStacks.length > 0 ? ` · off: ${summary.offStacks.join(", ")}` : "";
  return `${summary.stackCount} stacks · ${summary.activeCount}/${summary.totalCount} skills active${off}`;
}

function warnMissingSkills(ctx: ExtensionCommandContext, view: StacksView) {
  const detail = Object.entries(missingSkillNames(view.stacks, view.discovered))
    .map(([stack, names]) => `${stack}: ${names.join(", ")}`)
    .join("; ");
  if (detail) ctx.ui.notify(`Stacks reference unknown skills (${detail})`, "warning");
}

function listStacks(view: StacksView) {
  const summary = summarizeStacks(view.stacks, view.disabledStacks, view.discovered);
  const rows = view.stackNames.map((name) => {
    const state = view.disabledStacks.includes(name) ? "off" : "on";
    return `${name}: ${state} (${(view.stacks[name] ?? []).length} skills)`;
  });
  return `${formatSummary(summary)}\n${rows.join("\n")}`;
}

const usage = "Usage: /stacks [on <stack> | off <stack> | list]";

async function runStacksCommand(args: string, ctx: ExtensionCommandContext) {
  const view = loadView(ctx.cwd);
  warnMissingSkills(ctx, view);
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
        skillContents: readSkillContents(view.discovered),
      },
      (stacks, disabledStacks) => persistStacksState(view, stacks, disabledStacks),
    );
    if (result.outcome) ctx.ui.notify(formatSummary(result.outcome.summary), "info");
    if (result.settingsDirty) await ctx.reload();
    return;
  }

  if (view.stackNames.length === 0) {
    ctx.ui.notify(`No stacks configured. Run /stacks and press n, or edit ${globalConfigPath()}`, "warning");
    return;
  }

  if (trimmed === "list") {
    ctx.ui.notify(listStacks(view), "info");
    return;
  }

  const match = /^(on|off)\s+(\S+)$/.exec(trimmed);
  if (!match) {
    ctx.ui.notify(usage, "warning");
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
      ? sortNames([...view.disabledStacks, name])
      : view.disabledStacks.filter((entry) => entry !== name);
  const outcome = persistStacksState(view, view.stacks, next);
  ctx.ui.notify(formatSummary(outcome.summary), "info");
  if (outcome.settingsChanged) await ctx.reload();
}

// Completions fire on every keystroke and have no ctx; reuse one disk scan
// for a short window instead of rescanning the skill roots per key.
let completionCache: { at: number; view: StacksView | undefined } | undefined;
function completionView() {
  const now = Date.now();
  if (!completionCache || now - completionCache.at > 2_000) {
    let view: StacksView | undefined;
    try {
      view = loadView(process.cwd()); // pi runs in the session cwd
    } catch {
      view = undefined;
    }
    completionCache = { at: now, view };
  }
  return completionCache.view;
}

export default function skillStacks(pi: ExtensionAPI) {
  pi.registerCommand("stacks", {
    description: "Open the stacks overlay (or: on|off <stack>, list)",
    getArgumentCompletions: (prefix: string) => {
      const view = completionView();
      if (!view) return null;
      const disabled = new Set(view.disabledStacks);
      const stackItems = (action: "on" | "off") =>
        view.stackNames
          .filter((name) => disabled.has(name) === (action === "on"))
          .map((name) => ({ value: `${action} ${name}`, label: name }));
      const items = prefix.startsWith("on ")
        ? stackItems("on")
        : prefix.startsWith("off ")
          ? stackItems("off")
          : [
              { value: "on", label: "on <stack> - enable a stack" },
              { value: "off", label: "off <stack> - disable a stack" },
              { value: "list", label: "list - show current state" },
            ];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      try {
        await runStacksCommand(args, ctx);
      } catch (error) {
        if (error instanceof ConfigError) {
          ctx.ui.notify(`skill-stacks: ${error.message} — nothing was written`, "error");
          return;
        }
        throw error;
      }
    },
  });
}
