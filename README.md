# pi-skill-stacks

A [pi](https://github.com/earendil-works/pi-mono) package that groups your skills into named stacks you can toggle on and off, so an agent session only pays for the skills it needs. `/stacks` opens an overlay; disabled skills vanish from the system prompt, `/skill:` commands, and discovery.

## What it does

- `/stacks` opens a two-pane overlay. Left: stacks with on/off state, create (`n`) and delete (`d`). Right: the selected stack's members plus every other discovered skill — `space` moves a skill in or out of the stack, so you can re-stack without editing JSON. Changes persist as you make them; pi reloads once when you close the overlay (`esc`).
- `/stacks on <stack>` / `/stacks off <stack>` toggle a single stack; `/stacks list` prints state without changing anything.
- Toggling off writes `!skills/<name>/SKILL.md` exclusion patterns into the global settings `skills` array — pi's own override mechanism — so disabled skills are excluded everywhere, not just from the prompt. The extension only ever removes patterns it wrote itself (tracked in `managedExclusions`); hand-written `pi config` entries are left alone.
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

The package ships with no stacks; define your own in `~/.pi/agent/skill-stacks.json` (or `<agentDir>/skill-stacks.json`):

```json
{
  "stacks": {
    "frontend": ["react", "tailwind", "vite"],
    "writing": ["writing-beats", "writing-fragments"]
  }
}
```

Each stack maps a name to skill directory names (the directories containing a `SKILL.md`, searched in `~/.agents/skills/` and `<agentDir>/skills/`).

A project can add or override stack definitions in `<project>/.pi/skill-stacks.json`. Project stacks contribute definitions only; on/off state is global.

## Rules

- **Overlap:** a skill is excluded only when it appears in at least one stack and no enabled stack contains it. Skills in no stack are never touched. So disabling a stack whose members all also belong to an enabled stack excludes nothing.
- **Apply-once:** `on`/`off` commands apply immediately with a reload. In the overlay, every change is written to disk as you make it and a single reload runs when you close it, so the footer shows `reload pending` until then.

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

Your header extension can import `buildSkillsSection` and `isOurSection` from this package's `extensions/header.ts` to render the same compact line itself.

## Notes

- If a stack references skill names that don't resolve to a discovered skill, `/stacks` warns with the missing names.
- Counts in the overlay and header only include discovered skills, so a stale name doesn't inflate the numbers. Missing names are flagged inline.
