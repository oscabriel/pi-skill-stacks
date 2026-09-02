# pi-skill-stacks

A [pi](https://github.com/earendil-works/pi-mono) package that groups your skills into named stacks you can toggle on and off, so an agent session only pays for the skills it needs. `/stacks` opens an overlay; disabled skills vanish from the system prompt, `/skill:` commands, and discovery.

## What it does

- `/stacks` opens a two-pane overlay. Left: stacks with on/off state, create (`n`) and delete (`d`). Right: the selected stack's members plus every other discovered skill — `space` moves a skill in or out of the stack, so you can re-stack without editing JSON. Changes persist as you make them; pi reloads once when you close the overlay, and only if a toggle actually changed `settings.json`.
- `/stacks on <stack>` / `/stacks off <stack>` toggle a single stack (with argument completion); `/stacks list` prints state without changing anything. Bare `/stacks` outside the TUI (RPC/print mode) prints the list too.
- Toggling off writes `!skills/<dir>/SKILL.md` exclusion patterns into the global settings `skills` array — pi's own override mechanism — so disabled skills are excluded everywhere, not just from the prompt. The extension only ever removes patterns it wrote itself (tracked in `managedExclusions`); hand-written `pi config` entries are left alone.
- The bundled header extension replaces pi's startup `[Skills]` listing with a compact line like `matt-pocock (28), firecrawl (28) · 76/76 skills active` (with `off: <name> (n)` segments for disabled stacks) and hides the `[Themes]` section.

## Install

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

| Pane | Keys |
| --- | --- |
| stacks | `↑`/`↓` (or `k`/`j`) select · `space` on/off · `→`/`l`/`tab`/`enter` into members · `n` new stack · `d` delete · `esc`/`q` close |
| members | `↑`/`↓` (or `k`/`j`) move · `space` add/remove the skill · `←`/`h`/`tab`/`esc` back to stacks |

The title bar shows `reload pending` once a change has touched `settings.json`; the reload runs when you close the overlay.

## Rules

- **Overlap:** a skill is excluded only when it appears in at least one stack and no enabled stack contains it. Skills in no stack are never touched. So disabling a stack whose members all also belong to an enabled stack excludes nothing.
- **Stacks, not skills:** `on`/`off` take stack names only. To exclude a single skill regardless of stacks, use `pi config` (its `!` entries are respected and never claimed).
- **Persist-then-reload:** `on`/`off` commands write immediately and reload if `settings.json` changed. In the overlay every change is written as you make it and a single reload runs on close, again only if `settings.json` changed; re-stacking alone doesn't need one (the header line catches up on the next reload).
- **Other projects' stacks:** a project stack you disabled from inside its project stays disabled when you toggle things elsewhere. Its `disabledStacks` entry and the exclusions written for its skills are preserved, because from another directory those skills are "in no stack" and so left alone.

## Header

The header extension swaps pi's full skills listing for a compact summary and hides `[Themes]`. It also replaces the stock header banner with a minimal one-line directory label. If you run your own header extension (custom art, dashboard, and so on), disable this one and keep yours — add a filter to the package entry in `settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/oscabriel/pi-skill-stacks",
      "extensions": ["!extensions/header.ts"]
    }
  ]
}
```

Your header extension can import the section machinery from this package's `extensions/header.ts` to render the same compact line itself: `buildSkillsSection(cwd, theme)` builds the node, `replaceSkillsSection(root, node)` and `hideThemesSection(root)` splice pi's sections, `isOurSection`, `firstLineOf`, and `renderedText` are the matchers, and `SectionTheme`/`RenderableNode` are the structural types they take.

## Notes

- If a stack references skill names that don't resolve to a discovered skill, every `/stacks` invocation warns with the missing names, and the overlay flags them inline as `missing`.
- Counts in the overlay and header only include discovered skills, so a stale name doesn't inflate the numbers.
- `settings.json` is rewritten without a trailing newline to match pi's own formatting; `skill-stacks.json` ends with one.

## Develop

```bash
npm install        # dev-only: pi's type declarations for tsc
npm run check      # typecheck
npm test           # node --test
```
