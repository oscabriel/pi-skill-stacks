/**
 * pi-skill-stacks header extension: replaces pi's startup `[Skills]` section
 * with a compact one-line summary (e.g. `matt-pocock (28), firecrawl (28) ·
 * 76/76 skills active`), hides the `[Themes]` section, and renders a minimal
 * one-line banner in place of pi's stock header.
 *
 * Disable this file (settings.json package filter `!extensions/header.ts`) to
 * keep your own header extension; the /stacks command extension is unaffected.
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
import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

function hasChildren(
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(component.children);
}

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

// Marks the section node we build, so the addChild interceptor and the sweep
// never re-match it (its first rendered line is also exactly "[Skills]").
const SKILL_STACKS_SECTION = Symbol("skill-stacks-section");

export function isOurSection(component: RenderableNode): boolean {
  return (component as unknown as Record<symbol, unknown>)[SKILL_STACKS_SECTION] === true;
}

export function hideThemesSection(component: RenderableNode): boolean {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    const firstLine = renderedText(child)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();

    // Leaf check: pi's section components are childless ExpandableText nodes.
    // The parent resources container can render the same first line when it's
    // the first section, and matching it would splice out every section.
    if (firstLine === "[Themes]" && !hasChildren(child) && !isOurSection(child)) {
      const removeCount =
        component.children[index + 1] &&
        renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }

    if (hideThemesSection(child)) return true;
  }

  return false;
}

// Build a replacement [Skills] section styled like pi's own sections:
// mdHeading header line, dim indented body. The body lists each stack with
// its size, disabled stacks separately, plus the active-skill count.
// Data is read fresh from disk so it stays correct across /reload.
export function buildSkillsSection(cwd: string, theme: SectionTheme | undefined): Text | undefined {
  const summary = loadStacksSummary(cwd);
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
  (section as unknown as Record<symbol, unknown>)[SKILL_STACKS_SECTION] = true;
  return section;
}

export function replaceSkillsSection(component: RenderableNode, section: Text): boolean {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;

    // Matches pi's section header exactly. Leaf-only: the resources container
    // itself renders "[Skills]" first when no [Context] section precedes it,
    // and must not be replaced wholesale. Our own section also renders
    // "[Skills]" first, hence the marker check.
    if (firstLineOf(child) === "[Skills]" && !hasChildren(child) && !isOurSection(child)) {
      component.children.splice(index, 1, section as unknown as RenderableNode);
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
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}

export default function skillStacksHeader(pi: ExtensionAPI) {
  let cwd = process.cwd();
  let activeTui: DashboardTui | undefined;
  let sectionTheme: SectionTheme | undefined;
  let banner: string[] = [];
  let themeRemovalTimers: Array<ReturnType<typeof setTimeout>> = [];
  const interceptedContainers = new WeakSet<object>();

  // Wrap addChild on every container reachable from the TUI root so pi's
  // [Skills] section is swapped (and [Themes] dropped) at insertion time,
  // before the first paint.
  function interceptContainers(node: RenderableNode) {
    if (
      hasChildren(node) &&
      typeof node.addChild === "function" &&
      !interceptedContainers.has(node)
    ) {
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
            const section = buildSkillsSection(cwd, sectionTheme);
            if (section) {
              original(section as unknown as RenderableNode);
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
    const section = buildSkillsSection(cwd, sectionTheme);
    if (section && replaceSkillsSection(tui, section)) changed = true;
    if (changed) tui.requestRender(true);
  }

  function scheduleHeaderFixups(tui: DashboardTui) {
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];

    interceptContainers(tui);
    sweepHeader(tui);

    for (const delay of [0, 50, 250, 1_000]) {
      themeRemovalTimers.push(setTimeout(() => sweepHeader(tui), delay));
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
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];
    activeTui = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
    }
  });
}
