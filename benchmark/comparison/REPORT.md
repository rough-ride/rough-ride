# Does rough-ride beat plain Claude Code? Benchmark report

Run on 2026-11-12 with rough-ride at `main` after 0.1.5 (attacks and judging as in 0.1.4), Claude Code 2.1.322 and `claude-opus-5-5` for every arm, judge and verifier. Method: [DESIGN.md](DESIGN.md), fixed before the main runs; its last section lists the three changes made after them.

## Answer

**No, not on this benchmark.** Claude Code with a Playwright browser and a resilience checklist found every planted bug (18 of 18). rough-ride found 5 of 18, raised more false alarms, took about 3.5 times as long and cost about 1.5 times as much. rough-ride's one real advantage is narrow: it found 9 real defects that neither other arm reported, almost all from malformed or failing API responses on pages the change did not touch.

## Setup in one paragraph

One app (garden-log: Nuxt 4 + FastAPI), three features, two planted bugs per feature plus each feature's clean version: 9 variants. Three arms, three trials each: 81 headless runs, every one finished on its own, none hit the 45-minute limit, none changed the code. **Baseline** is Claude Code with its built-in tools. **Playwright** adds the Playwright MCP server with request mocking. Both get a prompt carrying rough-ride's own 11-point resilience checklist. **rough-ride** is the plugin run as `/rough-ride:standard`. A blind judge (no arm labels) matched findings to planted bugs and grouped the rest into 80 distinct issues; a separate verifier with a browser checked each issue on a fresh copy of the app.

## Results

| | Baseline | Playwright | rough-ride |
|---|---|---|---|
| Planted bugs found (observed) | **15 / 18** | **18 / 18** | **5 / 18** |
| 95% Wilson interval | 61% to 94% | 82% to 100% | 12% to 51% |
| Inside rough-ride's catalogue (15) / the logic control (3) | 12 / 3 | 15 / 3 | 5 / 0 |
| Findings reported (27 runs) | 200 | 212 | 316 (130 shown in the chat summary) |
| Precision, as judged | 65% | 60% | 19% |
| False alarms per run, as judged | 2.6 | 3.1 | 9.4 |
| False alarms per run on clean variants | 3.6 | 3.3 | 10.1 |
| Distinct real defects beyond the planted ones | 29 | 28 | 11 |
| ... of which no other arm found | | | 9 |
| Median time per run | 1.5 min | 3.3 min | 11.8 min |
| Median cost per run (list price) | $0.40 | $0.60 | $0.90 |
| Total tokens incl. cache reads, 27 runs | 7.4 M | 20.1 M | 17.6 M |

**Tests.** Recall, paired over the same 18 (bug, trial) pairs, exact McNemar:
- rough-ride vs Playwright: 0 pairs only rough-ride found, 13 pairs only Playwright found, p = 0.0002.
- rough-ride vs baseline: 3 against 13, p = 0.021.
- Playwright vs baseline: 3 against 0, p = 0.25, not distinguishable.

False alarms per run, permutation test: rough-ride against either other arm p < 0.001; Playwright against baseline p = 0.17.

**Judge reliability.** Two judge passes with different shuffles agreed on 725 of 727 planted-bug decisions.

### Per planted bug (found / 3 runs)

| Bug | Baseline | Playwright | rough-ride | Why rough-ride missed it |
|---|---|---|---|---|
| A failed stats load says "No harvests in this range" | 3 | 3 | 0 | Its `visible-error-message` check passes when any new text appears after the failure, and the empty-state text counts (`src/kind-fault.mts`, the `newLine` test). |
| A harvest on the To date is left out (logic control) | 3 | 3 | 0 | Outside its catalogue by design. |
| An apostrophe in the journal search breaks the SQL (500) | 3 | 3 | 0 | It sends bad input only into fields on recorded flows; no flow used the search box. |
| A failed journal save clears the typed text | 0 | 3 | **3** | |
| A double click on "Water now" records twice | 3 | 3 | 2 | |
| -5 litres is accepted | 3 | 3 | 0 | It typed -5; the app accepted it, and an accepted value counts as a valid outcome, so no check ran. |

### Where the false alarms come from

Of rough-ride's 255 false alarms, 166 are one issue. A bed's Delete button is disabled on purpose while the bed has plants, with a tooltip saying so. rough-ride's `settles` check reads any control still disabled after 10 seconds as stuck. Every flow that passes `/beds` with seeded data hit it, and that failure then rode along on every attack in the flow. Most of the rest are "no way to retry without a reload". The verifier rejected these on some pages and confirmed them on others, which says more about that check's ambiguity than about either side.

Two readings that favour rough-ride (`sensitivity.mjs`, `results/sensitivity.json`) do not change the conclusion:

| Reading | Baseline | Playwright | rough-ride |
|---|---|---|---|
| A. Every "no retry" or "no timeout" issue counts as real (the checklist asks for both) | 87%, 1.0 per run | 88%, 0.9 per run | 38%, 7.3 per run |
| B. Leave out the deliberately disabled Delete button | 65%, 2.6 | 60%, 3.1 | 41%, 3.3 |
| A and B together | 87%, 1.0 | 88%, 0.9 | 80%, 1.1 |

Each cell is precision, then false alarms per run. Counting only what rough-ride shows in its chat summary (130 findings) leaves recall at 5 of 18 and gives 25% precision.

### What rough-ride found that nobody else did

9 confirmed defects, all from runtime faults the code-reading arms did not try:
- The dashboard shows "undefined" or "NaN" when `/api/dashboard/summary` or `/api/tasks/upcoming` returns malformed JSON (found on two features).
- The dashboard has no retry after those requests fail.
- "Add bed" stays busy after `/api/beds` returns malformed JSON.
- `/beds` and `/waterings` throw uncaught errors after their lists fail to load or come back malformed.

Most sit in pages the change did not touch. So they are real, but they are not regressions of the change under review.

## Does it justify installing?

Not as a replacement for asking Claude Code to test with a browser. On this benchmark that is faster, cheaper, finds more planted bugs and raises fewer false alarms. rough-ride adds a small, real complement: malformed-response and failed-request faults that the other arms rarely try. Against that, its false alarms on this app outnumber its real findings unless the disabled-control case is fixed. The gaps behind its misses are concrete and fixable:
1. An error check that accepts empty-state text as an error message.
2. Bad input is never typed into fields off the recorded flows, such as search boxes.
3. An accepted bad value is never judged.
4. Deliberately disabled controls are read as stuck.

## Limits

- **One app, one stack, six bugs.** The maintainer wrote them, knows rough-ride's catalogue and put five of six inside it. That should favour rough-ride; it did not help.
- **The bugs are visible in the diff**, which favours arms that read code. Bugs far from the diff, or only visible at runtime, may favour rough-ride; the 9 unique defects hint at this.
- **Judge, verifier and arms are the same model family.** Verifier verdicts on "no retry" issues were inconsistent across pages; the sensitivity table brackets that.
- **The seed data matters.** A bed with plants triggered most of rough-ride's false alarms. Real data does that too, so it was kept, and reading B shows the effect.
- **Machine load.** Runs went two at a time on one machine, and rough-ride's attacks are time-budgeted. Its reports say attacks were cut for time (for example 66 not started in the pilot), so a quieter machine might let it try more.
- **Shared prompt and tools.** All arms ran headless with `--permission-mode bypassPermissions`. The checklist in the other arms' prompt is rough-ride's own text, so those prompts are stronger than what most users type.

## Reproduce

```sh
export BENCH_WORK=$TMPDIR/rr-bench/work PW_MCP_DIR=<folder with @playwright/mcp@0.0.83 installed>
npm run build
node benchmark/comparison/reference.mjs 3        # planted bugs observable, clean twins clean
node benchmark/comparison/schedule.mjs 3 2       # 81 runs, about 4.5 hours
node benchmark/comparison/judge.mjs 1 && node benchmark/comparison/judge.mjs 2
node benchmark/comparison/verify.mjs 4
node benchmark/comparison/analyze.mjs && node benchmark/comparison/sensitivity.mjs
```

The committed results include every run's prompt, findings, sanitized metadata, the judge passes, every verifier verdict and `summary.json`. Raw transcripts, app logs and rough-ride's run folders (screenshots, traces) stay local, because they are large and hold machine paths.
