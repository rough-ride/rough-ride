# rough-ride

```text
          _______________
         //   ||   ||    \\___
    ____//____||___||_____\\__\___         r o u g h - r i d e
   |   _        your app       _  |        drives your app down a rough road,
   '--(_)---------------------(_)-'        before your users do.
~~~~~^~~~~~~~~^~~~~~~~~^~~~~~~~~^~~~~~~~~~~~~~^~~~~~~~~~~~~~^~~~~~~~~~~^~~~~~~
    500    timeout    429    offline    double-click    bad input    375px
```

**Resilience testing for agent-built web apps.** After a coding agent changes your app, rough-ride attacks what changed with network faults, bad inputs and timing tricks in a real browser, and tells you where the app breaks or lies.

> Pre-release (0.x): detection and false-alarm rates are not measured yet. Do not rely on its verdicts.

## What you get

- **Targeted:** it attacks only what your branch changed, picked from the git diff.
- **Real:** it drives your own dev server in Chrome or Edge, through your saved flows.
- **Actionable:** every finding comes with a visible-browser repro and a regression test you can commit.

## Requirements

- Node.js 22.22+ and git
- Google Chrome or Microsoft Edge
- Claude Code 2.1.299+, for the plugin

## Quick start

### In Claude Code (recommended)

1. Install the plugin:
   ```
   /plugin marketplace add rough-ride/rough-ride
   /plugin install rough-ride@rough-ride
   ```
2. Start your app's dev server.
3. After a change, run:
   ```
   /rough-ride:quick
   ```

### From the terminal

With your dev server running, from the repository root:

```
npx rough-ride@0.1.1 quick
```

Add `--start` to let rough-ride start and stop the app itself; set `target.start` in `.rough-ride/config.yaml` first.

## Commands

| Command | What it does |
|---|---|
| `quick` | Attack this branch's changes in about 5 minutes |
| `standard` | The same, with a bigger budget |
| `regress` | Run the committed regression tests |
| `repro <id>` | Replay one finding in a visible browser |
| `flow save` | Save a flow to `.rough-ride/flows/` |
| `pr-comment` | Turn a CI run summary into a pull request comment |

Useful flags: `--start`, `--base <ref>`, `--browser chrome|msedge|chromium`, `--json`. Run `npx rough-ride@0.1.1 --help` for all of them.

## Configuration (optional)

Everything works without a config. When you need one, create `.rough-ride/config.yaml`; the package's `templates/config.yaml` lists every setting. The common ones:

```yaml
schema: 0.1.0
target:
  url: http://localhost:3000   # where your app runs
  start: npm run dev           # used by --start
reset: npm run db:reset        # runs before each sign-in
```

## Resilience contract

The resilience contract is optional text you paste into your repository's root `CLAUDE.md`. It tells the coding agent which failures its code will meet, so it builds error, empty and retry states from the start. It changes nothing rough-ride attacks or judges.

```markdown
<!-- resilience-contract edition=1 -->
## Resilience contract

Code you change here is tested in a real browser with requests that fail, are refused or rate-limited, lose the connection, never answer, answer late or return empty or unreadable data, plus expired sessions, double clicks, reloads, the back button, answers that arrive out of order, odd input and a 375 px wide screen. Design for these from the start:

1. When a request fails and retries do not fix it, say so on the page, not only in the console. Never show a failed or unreadable response as an empty list, a default or a success.
2. Requests your code sends time out after 10 seconds and fail like any other error; longer work, such as an upload, shows progress and can be cancelled. Nothing spins forever or stays disabled.
3. After a failure, trying again on the same page works once the server is back, without a reload. Never cache a failed result.
4. A failed or refused submit keeps everything the user typed.
5. Saving, sending or deleting twice, by a double click or a retry after a timeout, makes one change.
6. Every field accepts a value and shows it correctly, or refuses it with a visible reason, whatever is typed: blank, very long, emoji, other scripts, quotes, markup, extreme numbers or dates. The server validates every input and answers bad input with a 4xx, never a 5xx.
7. Treat responses as untrusted: error bodies may not be JSON, lists may be empty, fields may be null. No error goes uncaught, and the page never shows undefined, NaN, [object Object], Invalid Date or a stack trace.
8. A page that loads data has loading, empty and error states; its error state offers a retry and is the same whether the page was opened directly or through a link in the app.
9. When the session expires, take the user to sign in or say so; never loop or blank the page.
10. Pages fit 375 px wide without sideways scrolling, long user text included.
11. An answer that arrives late never replaces newer results on the page.

This is for real users on bad networks: the app behaves the same for every visitor.
<!-- /resilience-contract -->
```

To update it later, replace everything between the two marker lines. To decline it, paste only `<!-- resilience-contract declined -->`. Where else it may go, and its limits: [docs/resilience-contract.md](docs/resilience-contract.md). The text ships as `templates/resilience-contract.md` under MIT-0, so copy it freely.

## Run rough-ride on pull requests (GitHub Actions)

Each pull request gets one rough-ride comment, updated on every push. A finding never fails the job.

1. Run `npm i -D -E rough-ride@0.1.1`, then commit `.rough-ride/config.yaml`, `.rough-ride/flows/sign-in.yaml`, `.rough-ride/.gitignore` and the workflow below as `.github/workflows/rough-ride.yml`.
2. Make the config's `reset` (or the app) create the CI-only sign-in user from the flow's variables.
3. Never add its jobs to required status checks.

```yaml
# .github/workflows/rough-ride.yml
# Copied from templates/github-actions/rough-ride.yml in the rough-ride package (MIT-0).
# rough-ride attacks what this pull request changed and keeps one comment on it.
# A finding never fails it: only a failed checkout or install turns it red.
# Never add these jobs to required status checks or rulesets.
# Every action is pinned by its full 40-character commit SHA, with the release in the
# comment after it. Dependabot's github-actions updates move both.
name: rough-ride

on:
  pull_request:

permissions: {}

concurrency:
  group: rough-ride-${{ github.event.pull_request.number }}
  cancel-in-progress: true

env:
  RP_TIER: quick   # or standard: then set the tier step to 15 minutes and the attack job to 40

defaults:
  run:
    shell: bash

jobs:
  attack:
    name: rough-ride (non-blocking)
    runs-on: ubuntu-24.04            # Chrome is preinstalled; service containers need Linux
    timeout-minutes: 35              # install 5 + tier 10 + regress 15 + upload and render 5
    permissions:
      contents: read
    steps:
      - name: Check out the pull request with full history
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0             # the merge base and the reviewed versions need the base branch
          persist-credentials: false # no token in .git/config for the app or install scripts

      - name: Set up Node.js
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22           # rough-ride needs Node 22.22 or later
          cache: npm

      - name: Set up uv
        uses: astral-sh/setup-uv@07a047e608db84b3d8c06cd9a7c7dcc9c355c18e # v10.3.2
        with:
          python-version: "3.12"     # match backend/pyproject.toml

      - name: Install the app and the pinned rough-ride
        id: install
        run: |
          npm ci                               # package.json pins rough-ride as an exact devDependency
          uv sync --project backend --locked   # so --start doesn't spend its wait installing packages

      - name: rough-ride ${{ env.RP_TIER }}
        continue-on-error: true      # findings, stops and step timeouts never fail the job
        timeout-minutes: 10          # README formula: start wait + reset + hard stop + 150 s
        env:
          DEMO_EMAIL: demo@example.com           # a CI-only user in this job's throwaway database:
          DEMO_PASSWORD: demo-password           # not a secret, and never a real password
          SAMPLE_DB: ${{ runner.temp }}/app.db   # the app's own setting: a fresh SQLite file per job
        run: |
          mkdir -p "$RUNNER_TEMP/rough-ride"
          exec npx --no rough-ride "$RP_TIER" --start --json > "$RUNNER_TEMP/rough-ride/tier.json"

      - name: rough-ride regress
        if: ${{ !cancelled() && steps.install.outcome == 'success' }}
        continue-on-error: true
        timeout-minutes: 15
        env:
          DEMO_EMAIL: demo@example.com
          DEMO_PASSWORD: demo-password
          SAMPLE_DB: ${{ runner.temp }}/app.db
        run: |
          mkdir -p "$RUNNER_TEMP/rough-ride"
          exec npx --no rough-ride regress --start --json > "$RUNNER_TEMP/rough-ride/regress.json"

      - name: Upload run output
        id: upload
        if: ${{ !cancelled() && steps.install.outcome == 'success' }}
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: rough-ride-run-output
          # To leave screenshots out, add the line !.rough-ride/runs/**/*.png under path.
          path: .rough-ride/runs/
          include-hidden-files: true # .rough-ride is a dot folder: the default uploads nothing from it
          if-no-files-found: ignore  # nothing to attack, or no regression tests, writes no run folder
          retention-days: 14
          overwrite: true            # a re-run attempt replaces the earlier upload

      - name: Write the comment and the job summary
        if: ${{ !cancelled() && steps.install.outcome == 'success' }}
        continue-on-error: true      # a pr-comment exit 69 or 70 never fails the job; the comment job falls back
        env:
          ARTIFACT_URL: ${{ steps.upload.outputs.artifact-url }}
        run: |
          out="$RUNNER_TEMP/rough-ride"
          mkdir -p "$out"
          npx --no rough-ride pr-comment "$RP_TIER" "$out/tier.json" "$out/regress.json" \
            --artifact-url "$ARTIFACT_URL" > "$out/comment.md"
          cat "$out/comment.md" >> "$GITHUB_STEP_SUMMARY"
          echo "::notice title=rough-ride::$(head -n 1 "$out/comment.md")"

      - name: Hand the comment to the comment job
        if: ${{ !cancelled() && steps.install.outcome == 'success' }}
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: rough-ride-comment
          path: ${{ runner.temp }}/rough-ride/comment.md
          retention-days: 1
          overwrite: true

  comment:
    name: rough-ride comment
    needs: attack
    # Same-repository pull requests only. A fork's token is read-only, so a fork's run
    # keeps the same text in the attack job's summary.
    if: ${{ !cancelled() && github.event.pull_request.head.repo.full_name == github.repository }}
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      pull-requests: write           # list, create and edit this PR's comments; also lifts Dependabot's read-only token
    steps:
      - name: Download the comment
        continue-on-error: true      # missing when the attack job ended before writing it
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: rough-ride-comment
          path: ${{ runner.temp }}/rough-ride

      - name: Create or update the one rough-ride comment
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ github.event.pull_request.number }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          marker='<!-- rough-ride:pr-comment -->'
          body="$RUNNER_TEMP/rough-ride/comment.md"
          create=yes
          if [ ! -s "$body" ] || [ "$(tail -n 1 "$body")" != "$marker" ] || [ "$(wc -c < "$body")" -gt 60000 ]; then
            mkdir -p "$(dirname "$body")"
            printf '%s\n' \
              "rough-ride $RP_TIER | did not report | commit ${HEAD_SHA:0:7} | non-blocking" \
              "" \
              "The job ended before rough-ride wrote its comment (failed install, timeout or crash). [Job log]($RUN_URL)" \
              "$marker" > "$body"
            create=no   # a fallback only replaces an earlier comment; it never starts one
          fi
          if ! ids="$(gh api --paginate "repos/$REPO/issues/$PR/comments" --jq \
              '.[] | select(.user.login == "github-actions[bot]" and (.body | sub("\\s+$"; "") | endswith("<!-- rough-ride:pr-comment -->"))) | .id')"; then
            echo "::warning title=rough-ride::Could not read this pull request's comments; the attack job's summary has the text."
            exit 0
          fi
          id="$(printf '%s\n' "$ids" | head -n 1)"
          payload="$(jq -n --rawfile body "$body" '{body: $body}')"
          if [ -n "$id" ]; then
            gh api --method PATCH "repos/$REPO/issues/comments/$id" --input - <<< "$payload" > /dev/null \
              || echo "::warning title=rough-ride::Could not update the comment; the attack job's summary has the text."
          elif [ "$create" = yes ]; then
            gh api --method POST "repos/$REPO/issues/$PR/comments" --input - <<< "$payload" > /dev/null \
              || echo "::warning title=rough-ride::Could not post the comment; the attack job's summary has the text."
          fi
```

Written for Nuxt 4 + FastAPI. Other stacks, databases, package managers, timeouts, Dependabot pins and limits: [docs/github-actions.md](docs/github-actions.md). The template ships as `templates/github-actions/rough-ride.yml` under MIT-0.

## What rough-ride writes into your repo

Its files live in `.rough-ride/`: flows, repros, regression tests and a `.gitignore`. They are yours, with no licence header. It never writes `CLAUDE.md`, `AGENTS.md` or anything under `.claude/`.

## Licence

Copyright 2026 the rough-ride maintainers. Licensed under the MIT licence.
