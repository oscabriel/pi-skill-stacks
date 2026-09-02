# pi-skill-stacks

A [pi](https://github.com/earendil-works/pi-mono) package that groups skills into named stacks you can toggle on and off. Disabled skills leave the system prompt, `/skill:` commands, and discovery.

## Install

```bash
pi install npm:pi-skill-stacks
```

## Use

`/stacks` opens an overlay. Left pane: stacks with on/off state. Right pane: the selected stack's members. `enter` on a member shows its markdown.

| Pane | Keys |
| --- | --- |
| stacks | `↑`/`↓` select · `space` on/off · `→` members · `a` add skills · `n` new stack · `d` delete · `esc` close |
| members | `↑`/`↓` move · `space` remove · `→` view · `a` add skills · `←` back |
| viewer | `↑`/`↓` scroll (mouse wheel in fullscreen) · `←` back |

`a` lists skills not yet in any stack. To move a skill between stacks, `space` it out of one and `a` it into the other.

From the command line: `/stacks on <stack>`, `/stacks off <stack>`, `/stacks list`.

## How it works

Stacks live in `~/.pi/agent/skill-stacks.json` (`PI_CODING_AGENT_DIR` is honoured). You can edit it by hand:

```json
{
  "stacks": {
    "frontend": ["react", "tailwind", "vite"],
    "writing": ["writing-beats", "writing-fragments"]
  }
}
```

Skills are discovered like pi does: every `SKILL.md` under `~/.agents/skills/` and `<agentDir>/skills/`, named by frontmatter `name` or the directory name. A project can add stack definitions in `<project>/.pi/skill-stacks.json`; those can be toggled but not edited from the overlay.

Turning a stack off writes `!skills/<dir>/SKILL.md` patterns into the `skills` array of `~/.pi/agent/settings.json`, pi's own exclusion mechanism. The package only removes patterns it wrote itself; hand-written entries stay. A skill is excluded only when no enabled stack contains it, and skills in no stack are never touched. pi reloads once when the overlay closes, only if `settings.json` changed.

Stack names that don't match a discovered skill are flagged `missing` and not counted.

## Develop

```bash
npm install
npm run check
npm test
```
