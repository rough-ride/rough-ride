# Does /rough-ride:hunt beat plain Claude Code? Experiment report

Run on 2026-11-12 with Claude Code 2.1.322 and `claude-opus-5-5` for every arm, judge and verifier. Method: [DESIGN-hunt.md](DESIGN-hunt.md), written before the final runs, on top of [DESIGN.md](DESIGN.md). The engine under test is the redesign `/rough-ride:hunt` (`packages/rough-ride/src/hunt.mts`, `src/probe-host.mts`, `agents/hunter.md`, `skills/hunt/SKILL.md`), frozen after the dev pilot. The engine is in no release; the tested version is on the `stillhunter` branch at commit `__HUNT_SHA__`.

## Answer

**Not yet, by the rule set in advance, but close.** On six bugs kept from its author until the engine was frozen, `hunt` found 15 of 18 (Playwright 18 of 18), raised 0.4 false alarms per run against Playwright's 3.3, took the same median time (4.5 against 4.6 minutes) and cost 40% less. It missed one bug, 0 of 3, and for a reason that can be named exactly. The decision rule asks for recall no lower than Playwright's, so it fails rule 1 and passes rules 2 and 3.

Against the first engine (`/rough-ride:standard`, [REPORT.md](REPORT.md): 5 of 18, 9.4 false alarms per run, 11.8 minutes) it is a different tool.

## Held-out set: the result that counts

Six bugs (`hx1` to `hx6`, two per feature), written by a separate agent with reference checks while the engine was built. 9 variants x 3 arms x 3 trials = 81 runs; all finished, none hit the time limit, none changed the code.

| | Baseline | Playwright | hunt |
|---|---|---|---|
| Planted bugs shown in the browser | 8 / 18 | **18 / 18** | 15 / 18 |
| 95% Wilson interval | 25% to 66% | 82% to 100% | 61% to 94% |
| Findings reported (27 runs) | 243 | 250 | 91 |
| Precision, as judged | 65% | 65% | **88%** |
| False alarms per run | 3.1 | 3.3 | **0.4** |
| False alarms per run on clean variants | 3.0 | 3.4 | **0.9** |
| Distinct real defects beyond the planted ones | 27 | 34 | 15 |
| Median time per run | **1.7 min** | 4.6 min | 4.5 min |
| Median cost per run | **$0.47** | $0.79 | **$0.47** |
| Total tokens incl. cache reads | 9.2 M | 26.4 M | 9.5 M |

Baseline also described planted bugs in 10 more reports from reading the code, without showing them happen ("suspected"); as in the first comparison, only bugs shown count.

**Tests.** Recall, exact McNemar over the same 18 (bug, trial) pairs:
- hunt vs Playwright: 0 pairs only hunt found, 3 only Playwright found, p = 0.25.
- hunt vs baseline: 7 against 0, p = 0.016.
- Playwright vs baseline: 10 against 0, p = 0.002.

False alarms per run, permutation test: hunt against either arm p < 0.001; Playwright against baseline p = 0.70.

**Judge reliability.** Two blind passes agreed on 584 of 584 planted-bug decisions.

### Per planted bug (shown / 3 runs)

| Bug | Kind | Baseline | Playwright | hunt |
|---|---|---|---|---|
| hx1 | ordering | 0 | 3 | 3 |
| hx2 | logic | 3 | 3 | 3 |
| hx3 | failure handling | 0 | 3 | 3 |
| hx4 | logic | 3 | 3 | 3 |
| hx5 | layout at 375 px | 0 | 3 | **0** |
| hx6 | navigation | 2 | 3 | 3 |

### Why hunt missed hx5

At 375 px the past-watering form keeps three columns and squeezes the Date and Litres inputs to about 30 px. The form only renders after a click (`v-if`). In run 1 the hunter opened it at 375 px and asserted only that the page did not scroll sideways, which it does not. In runs 2 and 3 it loaded `/beds` at 375 px without opening the form, so the form was never on screen. In all three runs it checked only `overflowX`, the one layout signal `rr.observe()` reports, and it never looked at the page: the probe API has no screenshot. Playwright found hx5 in all three runs by taking a screenshot and reading it, with the same checklist wording ("without sideways scrolling"). So the miss comes from perception (no screenshot, no field geometry) and from not opening each state the change adds at 375 px, not from the checklist line alone.

### Decision rule (DESIGN-hunt.md)

| Rule | Needed | Observed | |
|---|---|---|---|
| 1. Planted bugs | no significant deficit, point estimate not lower | 15 vs 18, p = 0.25 | **fails** (point estimate lower) |
| 2. False alarms per run | not higher | 0.4 vs 3.3 | passes |
| 3. Median time | within 1.5 x Playwright | 4.5 vs 4.6 min | passes |

So the pre-registered outcome stands: on this evidence the recommended setup is still Claude Code with a browser and the checklist. The redesign is the first rough-ride engine that is competitive, and it is clearly better on precision and cost.

### What hunt's false alarms were

All 11 are one class: "no retry after a load error" or "no timeout on a hung request" (stats, journal, waterings). The verifier rejected them, and it was also inconsistent about that class in the first comparison. Counting that class as real (reading A in `sensitivity.mjs`) gives hunt 100% precision and 0 false alarms per run, against 88% and 1.1 for Playwright. The finish step's double re-run dropped 4 of 95 claimed findings.

### What hunt found beyond the planted bugs

15 distinct confirmed defects, mostly runtime faults: pages crashing or showing "Never" rows on a malformed or non-list response, a hung filter request leaving other beds' rows on screen, a blank date silently defaulting, year-1 dates accepted, amounts under 0.005 L shown as "0 L", a 500 on a huge integer id. Playwright found more distinct extras (34) because it reports about three times as many findings.

## Dev set: the bugs the author knew

The six bugs of the first comparison. hunt ran 27 times in this experiment (`results-hunt-final/`); the other arms are the first comparison's runs (same model and harness, earlier the same day).

| | Baseline | Playwright | hunt |
|---|---|---|---|
| Planted bugs shown | 15 / 18 | 18 / 18 | **18 / 18** |
| Precision, as judged | 65% | 60% | **95%** |
| False alarms per run | 2.6 | 3.1 | **0.1** |
| Median time per run | 1.5 min | 3.3 min | 2.0 min |
| Median cost per run | $0.40 | $0.60 | **$0.24** |

hunt vs Playwright: 0 against 0 discordant pairs; false alarms p < 0.001. Judge passes agreed on 60 of 60 planted decisions. 16 distinct real extras; no claimed finding was dropped on re-run.

This set is weaker evidence: the engine's author knew these bugs, and hunt was judged in its own pool rather than shuffled together with the other arms' findings.

## Limits

- **One app, one stack, six held-out bugs.** A difference of one bug kind decides rule 1. Three trials per bug cannot separate 15/18 from 18/18 statistically (p = 0.25).
- **The held-out bugs are now spent.** The hx5 fix below can be tested only on new bugs written by someone who has not seen the engine.
- **The dev-set result is not evidence for the engine.** `agents/hunter.md` names the six dev bugs almost word for word, and its example probe reproduces one of them.
- **Containment is weaker than the design says.** The loopback guard covers HTTP requests from pages in the probe's one browser context. Probes are Node modules imported into the runner's process, so a probe can reach other hosts, files and processes. That has to be closed before the engine ships.
- **Same model family** for arms, judge and verifier. Verifier verdicts on "no retry" and "no timeout" issues remain the softest part of the false-alarm counts; the sensitivity reading brackets them.
- **Machine load.** Held-out runs went three at a time; hunt's 12-minute budget was never reached (longest run under 8 minutes).
- **Prompts.** All arms ran headless with `--permission-mode bypassPermissions`. Baseline and Playwright carry rough-ride's own 11-point checklist, stronger than what most users type.

## Next step, if the work continues

1. Give the hunter a screenshot it reads, add layout candidates to `rr.observe()` (a value or placeholder that does not fit its field, clipped text), and require opening every page, form and expanded state the change adds at 375 px with maximum-length text. A field-width check alone would not have caught hx5 in runs 2 and 3, where the form was never opened.
2. Have a fresh agent write a new held-out set (six bugs, reference checks) without seeing the engine, freeze the engine, and rerun hunt and Playwright under the same rule.

## Reproduce

```sh
export BENCH_WORK=$TMPDIR/rr-bench/work PW_MCP_DIR=<folder with @playwright/mcp@0.0.83 installed>
npm run build
node benchmark/comparison/heldout-reference.mjs
H="BENCH_RESULTS=benchmark/comparison/results-heldout BENCH_SET=heldout BENCH_ARMS=baseline,playwright,hunt"
env $H node benchmark/comparison/schedule.mjs 3 3
env $H node benchmark/comparison/judge.mjs 1 && env $H node benchmark/comparison/judge.mjs 2
env $H BENCH_LANE_OFFSET=3 node benchmark/comparison/verify.mjs 3
env $H node benchmark/comparison/analyze.mjs && env $H node benchmark/comparison/sensitivity.mjs
# dev set: BENCH_RESULTS=benchmark/comparison/results-hunt-final BENCH_ARMS=hunt, same steps
```

Committed results hold every run's prompt, findings and sanitized metadata, both judge passes, every verifier verdict and `summary.json`. Raw transcripts, app logs and hunt's run folders (probe scripts and their results) stay local.
