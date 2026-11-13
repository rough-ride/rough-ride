# Comparison benchmark: design (written before the main runs)

Question: does rough-ride find more real bugs, with fewer false alarms, than Claude Code without it, at what cost in time and tokens?

## Arms

All arms run `claude -p` with the same model (`claude-opus-5-5`, default effort), `--setting-sources project --strict-mcp-config --permission-mode bypassPermissions`, from a fresh copy of the same variant, with the app already running and seeded, and `DEMO_EMAIL` / `DEMO_PASSWORD` set. No user or global instructions, plugins, MCP servers or memories reach any arm.

| Arm | Extra tools | Prompt |
|---|---|---|
| `baseline` | none (Claude Code's built-in tools) | `prompts/common.md` + `prompts/tools-baseline.md` |
| `playwright` | Playwright MCP 0.0.83, headless Chrome, `--caps network,storage` (request mocking, offline) | `prompts/common.md` + `prompts/tools-playwright.md` |
| `rough-ride` | the rough-ride plugin from `packages/rough-ride` (`--plugin-dir`) | `/rough-ride:standard` |

The two non-rough-ride prompts carry rough-ride's own published resilience checklist (the 11 items of `templates/resilience-contract.md`), so they are told what rough-ride checks. They also ask for any other bug, including a feature that doesn't do what the request asks. They state 30 minutes. Every arm is killed at 45 minutes.

## Variants

One app (garden-log, Nuxt 4 + FastAPI), three features, two planted bugs per feature, plus each feature's clean version: 9 variants. The bugs were written before any arm ran on them:

| Feature | Bug | Category | Inside rough-ride's catalogue? |
|---|---|---|---|
| harvest-stats | `error-shown-as-empty`: a failed stats load shows "No harvests in this range" | silent failure | yes (fault injection) |
| harvest-stats | `to-date-excluded`: a harvest on the To date is left out | logic | no (control) |
| plant-journal | `search-quote-crash`: an apostrophe in the search breaks the SQL (500) | input guard | yes (bad input) |
| plant-journal | `failed-save-clears-text`: a failed save clears the typed entry | state lost | yes (fault injection) |
| watering-log | `water-now-twice`: a double click on "Water now" records two waterings | double submit | yes (double click) |
| watering-log | `negative-litres`: -5 litres is saved | input guard | yes (bad input) |

`reference.mjs` proves each bug is observable: its check fails on its own variant and passes on the clean variant and the other bug's variant. It runs before the main runs and its result is kept in `results/reference.json`.

## Procedure

`schedule.mjs 3 2`: every variant x arm x trial, 3 trials (81 runs), in one fixed shuffled order (seed 20261112), two at a time on separate ports (the pilot showed three at a time loads the machine enough to slow rough-ride's time-budgeted attacks). Each run records the load average before and after. Each run: materialize the variant (`npm run bench -- materialize ... --ports`), install, reset the database, start `npm run dev`, warm the pages, seed the same data (2 beds, 3 plants, 6 harvests, plus 3 journal entries or 2 waterings for those features), run the arm, keep its output, transcripts and rough-ride's run folder, stop the app, delete the copy. The pilot (trial 0) is kept but not scored.

Arms never see manifests, provenance, reference checks or this folder: the variant folder holds only what `materialize` writes.

## Scoring

1. Every finding is put in one shape (title, where, steps, expected, actual, evidence, observed or suspected). rough-ride's findings are converted from its `summary.json` and `report.txt`; they count as observed because rough-ride ran them in a browser.
2. A judge (`claude -p`, same model, a fresh session that knows nothing about the arms) gets, per feature, the two planted bug descriptions and every finding of that feature, shuffled, with opaque ids and the variant each came from, but not the arm. It marks which findings describe the planted bug of their variant and groups the rest into distinct issues. It runs twice with different shuffles; disagreements are reported, and the first pass is scored.
3. Every distinct issue that is not a planted bug is checked by a verifier (`claude -p` with Playwright MCP, on a fresh clean copy of the feature): confirmed defect, not reproduced, or not a defect (works as asked or as designed). The verifier sees the issue, not which arm reported it.
4. Per run: a planted bug is **found** when an observed finding matches it, **mentioned** when only a suspected finding does. Each finding is a planted bug, a confirmed extra defect, or a false alarm (not reproduced or not a defect).

## Measures

- Recall on planted bugs: found / planted, per arm, over 6 bugs x 3 trials = 18 chances. Also split into inside and outside rough-ride's catalogue.
- Precision: (planted + confirmed extra) / all findings, per arm.
- False alarms per run, on clean variants and overall.
- Distinct confirmed extra defects per arm (union over runs) and per run.
- Time (wall clock), tokens (input, output, cache read, cache write, from every transcript including subagents), cost (Claude Code's reported cost for the main session, plus subagent tokens priced the same way).
- Reproducibility: for each arm and planted bug, how many of the 3 trials found it.
- Setup effort: what each arm needs before it can run, recorded by hand.

## Statistics

Recall per arm with a 95% Wilson interval. Paired comparison between two arms over the 18 (bug, trial) pairs with an exact McNemar test (two-sided binomial on discordant pairs). False alarms per run compared with a two-sided permutation test on the difference in means (10,000 shuffles, fixed seed) over the 27 runs per arm. With 18 chances per arm only large differences can be called; anything else is reported as not distinguishable.

## Known limits, stated up front

- One app, one stack, six bugs written by the maintainer, who knows rough-ride's catalogue. Five of six bugs sit inside it, which favours rough-ride; the other arms are told the same checklist to offset that.
- Planted bugs sit in the diff, where a code-reading model can see them. That favours arms that read code; real bugs are often less visible.
- The judge and verifier are the same model family as the arms.
- Runs share one machine two at a time, so timing-sensitive tools may be affected by load; the shuffled order spreads that over arms, and the load is recorded.

## Changes made after the runs

Recorded here instead of edited into the text above, which is as it stood before the main runs.

1. **rough-ride findings come from every finding in `report.txt`, not only the ones `summary.json` shows.** rough-ride shows at most five findings per run and lists the rest in `report.txt` as capped, unchecked or not confirmed. The first extraction read `summary.json` only (130 findings over 27 runs); the scored one reads the whole report (316). This is the more generous reading for rough-ride; the shown-only numbers are reported as a sensitivity check. The judge ran again over the larger set; the earlier judge output is kept in `results/judge-superseded/`.
2. **An issue every report of which came from one buggy variant is verified on that variant**, not on the clean one, so a side effect of a planted bug is not called "not reproduced".
3. **Cost** is computed per run from the main session's reported cost and the token counts of every transcript (a code fix: the first analysis passed the wrong object).
