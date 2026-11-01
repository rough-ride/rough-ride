# rough-ride

<p align="center"><img src="https://raw.githubusercontent.com/rough-ride/rough-ride/main/docs/banner.png" alt="rough-ride: drives your app down a rough road, before your users do." width="100%"></p>

**Resilience testing for agent-built web apps.** After a coding agent changes your app, rough-ride attacks what changed with network faults, bad inputs and timing tricks in a real browser, and tells you where the app breaks or lies.

> Pre-release (0.x): detection and false-alarm rates are not measured yet. Do not rely on its verdicts.

## Quick start

You need Node.js 22.22+, git, and Google Chrome or Microsoft Edge.

**In Claude Code (2.1.299+):**

```
/plugin marketplace add rough-ride/rough-ride
/plugin install rough-ride@rough-ride
```

Then start your dev server and, after a change, run `/rough-ride:quick`.

**From the terminal**, with your dev server running, in the repository root:

```
npx rough-ride@0.1.2 quick
```

The terminal attacks only through flows saved in `.rough-ride/flows/`, which the plugin writes for you (or use `flow save`). On a new repository, start with the plugin.

Every finding comes with a repro you can replay in a visible browser and a regression test you can commit.

## Commands

| Command | What it does |
|---|---|
| `quick` | Attack this branch's changes in about 5 minutes |
| `standard` | The same, with a bigger budget |
| `regress` | Run the committed regression tests |
| `repro <id>` | Replay one finding in a visible browser |
| `flow save` | Save a flow to `.rough-ride/flows/` |
| `pr-comment` | Turn a CI run summary into a pull request comment |

Flags: `--start` starts and stops your app, `--base <ref>`, `--browser chrome|msedge|chromium`, `--json`.

**Config:** a single Nuxt app needs no config. For any other app, set `target.url` (and `target.start` for `--start`) in `.rough-ride/config.yaml`; [`templates/config.yaml`](https://github.com/rough-ride/rough-ride/blob/main/packages/rough-ride/templates/config.yaml) lists every setting.

## Learn more

- [Run rough-ride on pull requests](https://github.com/rough-ride/rough-ride/blob/main/docs/github-actions.md): the GitHub Actions template, setup steps and variants.
- [Resilience contract](https://github.com/rough-ride/rough-ride/blob/main/docs/resilience-contract.md): optional text for your `CLAUDE.md` that tells coding agents which failures to design for.

rough-ride writes only under `.rough-ride/`, and never touches `CLAUDE.md`, `AGENTS.md` or `.claude/`.

## Licence

MIT
