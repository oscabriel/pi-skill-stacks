# pi-skill-stacks

A [pi](https://github.com/earendil-works/pi-mono) package that groups your skills into named stacks you can toggle on and off, so an agent session only pays for the skills it needs. `/stacks` opens an overlay; disabled skills vanish from the system prompt, `/skill:` commands, and discovery.

## What it does

- `/stacks` opens a two-pane overlay. Left: stacks with on/off state, create (`n`), delete (`d`), and `a` to add skills that aren't in any stack yet. Right: the selected stack's members; `space` removes one, `enter` opens the skill's full markdown in a viewer pane. So you can build and edit stacks without touching JSON. Changes persist as you make them; pi reloads once when you close the overlay, and only if a toggle actually changed `settings.json`.
- `/stacks on <stack>` / `/stacks off <stack>` toggle a single stack (with argument completion); `/stacks list` prints state without changing anything. Bare `/stacks` outside the TUI (RPC/print mode) prints the list too.
- Toggling off writes `!skills/<dir>/SKILL.md` exclusion patterns into the global settings `skills` array — pi's own override mechanism — so disabled skills are excluded everywhere, not just from the prompt. The extension only ever removes patterns it wrote itself (tracked in `managedExclusions`); hand-written `pi config` entries are left alone.
- Nothing else. The package doesn't touch pi's header or startup listing; if you want a compact stacks line up there, see [Summary data for your own header](#summary-data-for-your-own-header).

## Install

```bash
pi install npm:pi-skill-stacks
```

or from git:

```bash
pi install git:github.com/oscabriel/pi-skill-stacks
```

Or from a local checkout:

```bash
pi install /path/to/pi-skill-stacks
```

Use `-l` to install project-local instead of global. Try it without installing:

```bash
pi -e git:github.com/oscabriel/pi-skill-stacks
```

## Configure stacks

The package ships with no stacks. Open `/stacks` and press `n` to create one, or write `~/.pi/agent/skill-stacks.json` (or `<agentDir>/skill-stacks.json`; `PI_CODING_AGENT_DIR` is honoured like pi does) by hand:

```json
{
  "stacks": {
    "frontend": ["react", "tailwind", "vite"],
    "writing": ["writing-beats", "writing-fragments"]
  }
}
```

Each stack maps a name to skill names. Skills are discovered the way pi discovers them: every `SKILL.md` under `~/.agents/skills/` and `<agentDir>/skills/`, recursing into subdirectories (skipping dot-directories and `node_modules`), named by the frontmatter `name` or, failing that, the directory name. Nested skills get full-path exclusion patterns such as `!skills/group/nested/SKILL.md`.

A project can add or override stack definitions in `<project>/.pi/skill-stacks.json`. Project stacks contribute definitions only; on/off state is global. In the overlay they can be toggled but not edited or deleted — edit the project file instead.

The config file is validated on every load. A malformed entry (a stack that isn't an array, invalid JSON, and so on) aborts the command with an error and nothing is written, rather than defaulting to an empty config and saving that back.

## Overlay keys

Navigation is consistent across panes: `←`/`esc` always goes back a pane, `→`/`tab` (or `enter` on a member) always goes forward. `←` in the leftmost pane and `→` in the viewer do nothing.

| Pane | Keys |
| --- | --- |
| stacks | `↑`/`↓` (or `k`/`j`) select · `space` on/off · `→`/`l`/`tab`/`enter` into members · `a` add skills · `n` new stack · `d` delete · `esc`/`q` close |
| members | `↑`/`↓` (or `k`/`j`) move · `space` remove the skill · `enter`/`→`/`tab` view skill · `a` add skills · `←`/`h`/`esc` back to stacks |
| skill viewer | `↑`/`↓` (or `k`/`j`) scroll · `enter`/`←`/`h`/`esc` back to members |
| add skills dialog | `↑`/`↓` move · `space` mark · `enter` add the marked skills (or the highlighted one) · `esc` cancel |
| new stack / delete dialogs | `enter` confirm · `esc` cancel |

The `a`, `n` and `d` dialogs open as small overlays on top of `/stacks`. `a` lists only skills that no stack holds yet. To move a skill between stacks, `space` it out of one and `a` it into the other.

In fullscreen TUI mode the mouse wheel scrolls the skill viewer when the pointer is over the overlay. In regular mode the terminal owns the mouse and wheel input goes to its own scrollback.

`enter` in the members pane opens the skill's full markdown in a viewer pane inside the overlay: frontmatter dim, headings bold, bullets and indented code rendered, links shown as their text.

The title bar shows `reload pending` once a change has touched `settings.json`; the reload runs when you close the overlay.

## Rules

- **Overlap:** a skill is excluded only when it appears in at least one stack and no enabled stack contains it. Skills in no stack are never touched. So disabling a stack whose members all also belong to an enabled stack excludes nothing.
- **Stacks, not skills:** `on`/`off` take stack names only. To exclude a single skill regardless of stacks, use `pi config` (its `!` entries are respected and never claimed).
- **Persist-then-reload:** `on`/`off` commands write immediately and reload if `settings.json` changed. In the overlay every change is written as you make it and a single reload runs on close, again only if `settings.json` changed; re-stacking alone doesn't need one.
- **Other projects' stacks:** a project stack you disabled from inside its project stays disabled when you toggle things elsewhere. Its `disabledStacks` entry and the exclusions written for its skills are preserved, because from another directory those skills are "in no stack" and so left alone.

## Summary data for your own header

The package never calls `ctx.ui.setHeader` or edits pi's startup sections. If your own header extension wants to show stacks (say, `matt-pocock (28), firecrawl (28) · 76/76 skills active` in place of pi's full `[Skills]` listing), read the data from `src/store.ts`:

```ts
import { loadStacksSummary } from "<install path>/pi-skill-stacks/src/store.ts";

const summary = loadStacksSummary(process.cwd());
// undefined when no stacks are configured; throws ConfigError on a malformed file
// summary.stacks: [{ name, size, enabled }], in definition order
// summary.activeCount / summary.totalCount: discovered skills, after exclusions
```

For an npm install, `<install path>` is `~/.pi/agent/npm/node_modules`. It reads fresh from disk on every call, so a `/reload` picks up changes made in `/stacks`.

## Notes

- If a stack references skill names that don't resolve to a discovered skill, every `/stacks` invocation warns with the missing names, and the overlay flags them inline as `missing`.
- Counts in the overlay and in `loadStacksSummary` only include discovered skills, so a stale name doesn't inflate the numbers.
- `settings.json` is rewritten without a trailing newline to match pi's own formatting; `skill-stacks.json` ends with one.

## Develop

```bash
npm install        # dev-only: pi's type declarations for tsc
npm run check      # typecheck
npm test           # node --test
```
