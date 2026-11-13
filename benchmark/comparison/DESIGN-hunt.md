# Experiment: /rough-ride:hunt against plain Claude Code (written before the final runs)

The first comparison ([REPORT.md](REPORT.md)) found rough-ride's fixed-catalogue engine well behind Claude Code with Playwright and a checklist. This experiment tests a redesigned engine, `/rough-ride:hunt`. In it, the model reads the change, plans spec checks, code suspicions and a resilience sweep, and tests each one with probe scripts. The runner supplies fault injection, observation, a loopback-only browser and a final step that re-runs every claimed finding twice from scratch. Code: `packages/rough-ride/src/hunt.mts`, `src/probe-host.mts`, `agents/hunter.md`, `skills/hunt/SKILL.md`.

## Sets

- **Held-out** (`BENCH_SET=heldout`): six bugs `hx1` to `hx6`, two per feature. A separate agent wrote them, with reference checks (`heldout-reference.mjs`, all 18 results as expected, `results/heldout-reference.json`), while the engine was being built. The engine's author has not read them.
- **Dev**: the six bugs of the first comparison, which the engine's author knew.

## Freeze

The hunter is frozen at the version that ran the dev pilot (`results-hunt-dev/`, one trial per dev variant), with no change made after it. The pilot is not scored.

## Runs

- Held-out: `baseline`, `playwright` and `hunt` arms x 9 variants x 3 trials (81 runs), into `results-heldout/`.
- Dev: `hunt` x 9 variants x 3 trials (27 runs), into `results-hunt-final/`. It is compared with the first comparison's `baseline` and `playwright` runs: same model, same harness, same day.

Same arms setup, judging (two blind passes), verification and statistics as DESIGN.md, including its post-run changes.

## Decision rule

The redesign is worth continuing only if, on the **held-out** set, `hunt` against `playwright`:
1. finds at least as many planted bugs (no significant deficit, and a point estimate not lower);
2. raises no more false alarms per run (point estimate);
3. has a median time per run within 1.5 times Playwright's.

Otherwise the honest outcome stands: the recommended setup is plain Claude Code with a browser and the checklist.

## Changes made after the runs

These touch scoring scripts only; no run, finding or verdict changed.
- `analyze.mjs` compared fixed arm pairs that included the old `rough-ride` arm. It now compares every pair of the arms present, `hunt` first.
- `verify.mjs` takes `BENCH_LANE_OFFSET`, so held-out verification could run on lanes 3 to 5 while the dev-set hunt runs still held lanes 0 to 2.
- The dev-set hunt runs were judged in their own pool, not shuffled together with the first comparison's baseline and Playwright findings.
- Each held-out `provenance.md` says "Written by hand": the separate agent wrote each bug itself rather than generating it by mutation. The two accounts describe the same thing.
- Result files were scrubbed of this machine's temporary paths (`$BENCH_WORK` stands in for them), and `trial.mjs` and `verify.mjs` now write them that way.
