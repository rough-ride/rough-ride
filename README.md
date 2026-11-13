# rough-ride

<p align="center"><img src="https://raw.githubusercontent.com/rough-ride/rough-ride/main/docs/banner.png" alt="rough-ride: drives your app down a rough road, before your users do." width="100%"></p>

**Resilience testing for agent-built web apps.** After a coding agent changes your app, rough-ride attacks what changed with network faults, bad inputs and timing tricks in a real browser, and tells you where the app breaks or lies.

> **Measured: so far, worse than asking Claude Code to test with a browser.** On our benchmark (one Nuxt + FastAPI app, six planted bugs, three runs each), `/rough-ride:standard` caught the planted bug in 5 of 18 runs (2 of the 6 bugs) and raised 9.4 false alarms per run. Claude Code with Playwright and a resilience checklist caught it in 18 of 18 runs, with 3.1 false alarms per run ([report](https://github.com/rough-ride/rough-ride/blob/main/benchmark/comparison/REPORT.md)). A redesigned engine, tested on six new bugs kept from its author until it was frozen, caught the bug in 15 of 18 runs (5 of the 6 bugs) with 0.4 false alarms per run, against 18 of 18 runs and 3.3 for Claude Code with Playwright ([report](https://github.com/rough-ride/rough-ride/blob/main/benchmark/comparison/REPORT-hunt.md)). It is not in this release. Until it ships, treat findings as leads to check.

## Quick start

You need Node.js 22.22+, git, and Google Chrome or Microsoft Edge.

**In Claude Code:**

```
/plugin marketplace add rough-ride/rough-ride
/plugin install rough-ride@rough-ride
```

Then start your dev server and, after a change, run `/rough-ride:quick`.

**From the terminal**, with your dev server running, in the repository root:

```
npx rough-ride@0.1.6 quick
```

The terminal attacks only through flows saved in `.rough-ride/flows/`, which the plugin writes for you (or use `flow save`). On a new repository, start with the plugin.

Every finding comes with a repro you can replay in a visible browser and a regression test you can commit.

## Commands

| Terminal | In Claude Code | What it does |
|---|---|---|
| `quick` | `/rough-ride:quick` | Attack this branch's changes in about 5 minutes |
| `standard` | `/rough-ride:standard` | The same, with a bigger budget |
| `regress [--only <name>]` | `/rough-ride:regress [names]` | Run the committed regression tests |
| `repro <id>` | `/rough-ride:repro <id>` | Re-run one finding; in the terminal, `--keep-open` holds it in a visible browser |
| `flow save` | terminal only | Save a flow to `.rough-ride/flows/` |
| `pr-comment` | CI only | Turn a CI run summary into a pull request comment |

Terminal flags: `--start` starts and stops your app, `--base <ref>`, `--browser chrome|msedge|chromium`, `--json`.

**Focus a run:** write what the change should do in `.rough-ride/specs/<name>.txt` yourself (a lowercase name; the file new or changed on your branch). In Claude Code, `/rough-ride:quick` and `/rough-ride:standard` read it when they plan their attacks; terminal runs don't. The two slash commands take no arguments.

**Config:** a single Nuxt app needs no config. For any other app, set `target.url` (and `target.start` for `--start`) in `.rough-ride/config.yaml`; [`templates/config.yaml`](https://github.com/rough-ride/rough-ride/blob/main/packages/rough-ride/templates/config.yaml) lists every setting.

## Learn more

- [Run rough-ride on pull requests](https://github.com/rough-ride/rough-ride/blob/main/docs/github-actions.md): the GitHub Actions template, setup steps and variants.
- [Resilience contract](https://github.com/rough-ride/rough-ride/blob/main/docs/resilience-contract.md): optional text for your `CLAUDE.md` that tells coding agents which failures to design for.

rough-ride writes only under `.rough-ride/`, and never touches `CLAUDE.md`, `AGENTS.md` or `.claude/`.

## Licence

MIT
