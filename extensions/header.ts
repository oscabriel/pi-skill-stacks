/**
 * pi-skill-stacks header extension: replaces pi's startup `[Skills]` section
 * with a compact one-line summary (e.g. `matt-pocock (28), firecrawl (28) ·
 * 76/76 skills active`), hides the `[Themes]` section, and renders a minimal
 * one-line banner in place of pi's stock header.
 *
 * Disable this file (settings.json package filter `!extensions/header.ts`) to
 * keep your own header extension; the /stacks command extension is unaffected.
 * The section-building helpers are exported so a custom header can reuse them.
 *
 * Mechanism notes:
 * - pi's startup sections are childless leaves inside one container. The
 *   container's first rendered line can itself be "[Skills]" (when no
 *   [Context] section precedes it), so matchers require !hasChildren.
 * - showLoadedResources runs after extension session_start handlers, so
 *   post-paint sweeps alone flash the full listing for a frame. addChild
 *   wrapping swaps our node in at insertion time instead. Timed sweeps stay
 *   as fallback for late installs; resources_discover re-runs the walk.
 */
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadStacksSummary } from "../src/store.ts";

export interface RenderableNode {
  children?: RenderableNode[];
  addChild?(component: RenderableNode): void;
  invalidate(): void;
  render(width: number): string[];
}

/** Subset of pi's Theme we use; the real Theme is assignable to it. */
export interface SectionTheme {
  fg(color: "mdHeading" | "dim", text: string): string;
}

export interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const hasChildren = (
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } => Array.isArray(component.children);

export function renderedText(component: RenderableNode) {
  try {
    return component.render(200).join("\n").replace(ANSI_PATTERN, "");
  } catch {
    return "";
  }
}

export function firstLineOf(component: RenderableNode) {
  return renderedText(component)
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
}

// Marks the section nodes we build, so the addChild interceptor and the sweep
// never re-match them (their first rendered line is also exactly "[Skills]").
const ourSections = new WeakSet<object>();

export const isOurSection = (component: object) => ourSections.has(component);

/** A pi section leaf we should act on: exact header line, childless, not one of ours. */
const isPiSection = (child: RenderableNode, header: string) =>
  firstLineOf(child) === header && !hasChildren(child) && !isOurSection(child);

export function hideThemesSection(component: RenderableNode): boolean {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    // Leaf check: pi's section components are childless ExpandableText nodes.
    // The parent resources container can render the same first line when it's
    // the first section, and matching it would splice out every section.
    if (isPiSection(child, "[Themes]")) {
      const next = component.children[index + 1];
      const removeCount = next && renderedText(next).trim() === "" ? 2 : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }
    if (hideThemesSection(child)) return true;
  }
  return false;
}

/**
 * Build a replacement [Skills] section styled like pi's own sections:
 * mdHeading header line, dim indented body listing each stack with its size,
 * disabled stacks separately, plus the active-skill count. Data is read fresh
 * from disk so it stays correct across /reload. Returns undefined when no
 * stacks are configured or the config is unreadable (pi's section is left alone).
 */
export function buildSkillsSection(cwd: string, theme: SectionTheme | undefined) {
  let summary;
  try {
    summary = loadStacksSummary(cwd);
  } catch {
    return undefined;
  }
  if (!summary) return undefined;
  const heading = (text: string) => (theme ? theme.fg("mdHeading", text) : `${BOLD}${text}${RESET}`);
  const dim = (text: string) => (theme ? theme.fg("dim", text) : `${DIM}${text}${RESET}`);
  const label = (stack: { name: string; size: number }) => `${stack.name} (${stack.size})`;
  const on = summary.stacks.filter((stack) => stack.enabled).map(label).join(", ");
  const off = summary.stacks.filter((stack) => !stack.enabled).map(label).join(", ");
  const parts: string[] = [];
  if (on) parts.push(on);
  if (off) parts.push(`off: ${off}`);
  parts.push(`${summary.activeCount}/${summary.totalCount} skills active`);
  const section = new Text(`${heading("[Skills]")}\n${dim(`  ${parts.join(" · ")}`)}`, 0, 0);
  ourSections.add(section);
  return section;
}

export function replaceSkillsSection(component: RenderableNode, section: Text): boolean {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    if (isPiSection(child, "[Skills]")) {
      component.children.splice(index, 1, section);
      component.invalidate();
      return true;
    }
    if (replaceSkillsSection(child, section)) return true;
  }
  return false;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const rel = relative(home, cwd);
  return rel.startsWith("..") || isAbsolute(rel) ? cwd : `~/${rel}`;
}

export default function skillStacksHeader(pi: ExtensionAPI) {
  let cwd = process.cwd();
  let activeTui: DashboardTui | undefined;
  let sectionTheme: SectionTheme | undefined;
  let banner: string[] = [];
  let fixupTimers: Array<ReturnType<typeof setTimeout>> = [];
  const interceptedContainers = new WeakSet<object>();

  // One disk read per fixup cycle: the interceptor and every sweep in the
  // cycle share the same section instead of re-scanning the skill roots.
  let cachedSection: { cwd: string; section: Text | undefined } | undefined;
  function skillsSection() {
    if (!cachedSection || cachedSection.cwd !== cwd) {
      cachedSection = { cwd, section: buildSkillsSection(cwd, sectionTheme) };
    }
    return cachedSection.section;
  }

  // Wrap addChild on every container reachable from the TUI root so pi's
  // [Skills] section is swapped (and [Themes] dropped) at insertion time,
  // before the first paint.
  function interceptContainers(node: RenderableNode) {
    if (hasChildren(node) && typeof node.addChild === "function" && !interceptedContainers.has(node)) {
      interceptedContainers.add(node);
      const original = node.addChild.bind(node);
      let dropNextBlank = false;
      node.addChild = (child: RenderableNode) => {
        if (dropNextBlank) {
          dropNextBlank = false;
          // The spacer pi adds right after the section it belongs to.
          if (!renderedText(child).trim()) return;
        }
        if (!isOurSection(child)) {
          const firstLine = firstLineOf(child);
          if (firstLine === "[Themes]") {
            dropNextBlank = true;
            return;
          }
          if (firstLine === "[Skills]") {
            const section = skillsSection();
            if (section) {
              original(section);
              return;
            }
          }
        }
        original(child);
      };
    }
    if (hasChildren(node)) {
      for (const child of node.children) interceptContainers(child);
    }
  }

  // Fallback for sections that were inserted before we wrapped their
  // container (e.g. this extension loading into an already-painted session).
  function sweepHeader(tui: DashboardTui) {
    let changed = hideThemesSection(tui);
    const section = skillsSection();
    if (section && replaceSkillsSection(tui, section)) changed = true;
    if (changed) tui.requestRender(true);
  }

  function clearFixupTimers() {
    for (const timer of fixupTimers) clearTimeout(timer);
    fixupTimers = [];
  }

  function scheduleHeaderFixups(tui: DashboardTui) {
    clearFixupTimers();
    cachedSection = undefined;
    interceptContainers(tui);
    sweepHeader(tui);
    for (const delay of [0, 50, 250, 1_000]) {
      fixupTimers.push(setTimeout(() => sweepHeader(tui), delay));
    }
  }

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui, theme) => {
      activeTui = tui;
      sectionTheme = theme;
      const label = theme.fg("muted", formatDirectory(cwd));
      banner = [];
      scheduleHeaderFixups(tui);

      return {
        render(width: number) {
          // One dim centered line: the working directory.
          if (banner.length === 0) {
            const padding = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
            banner = [truncateToWidth(`${" ".repeat(padding)}${label}`, width)];
          }
          return banner;
        },
        invalidate() {
          banner = [];
        },
      };
    });
  });

  pi.on("resources_discover", () => {
    if (activeTui) scheduleHeaderFixups(activeTui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearFixupTimers();
    activeTui = undefined;
    if (ctx.mode === "tui") ctx.ui.setHeader(undefined);
  });
}
