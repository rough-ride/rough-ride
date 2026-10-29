# rough-ride

Pre-release (0.x): detection and false-alarm rates are not measured yet. Do not rely on its verdicts.

Resilience testing for agent-built code. rough-ride attacks a web app that a coding agent just changed with faults and bad inputs, and judges whether it stays usable and honest.

It runs locally against your own dev server, as a CLI and as a Claude Code plugin. It selects what to attack from the diff of your branch, runs your saved flows in a real browser, injects network faults and bad inputs, and reports findings with a repro and a regression test.

## Status

Nothing is released yet. The first release, 0.1.0, proves the target and runs baseline flows; attacks follow in later 0.x releases.

## Requirements

- Node.js 22.22 or later, and git
- Google Chrome or Microsoft Edge (or Playwright's Chromium, downloaded on your request)
- Claude Code 2.1.299 or later, for the plugin

## Resilience contract

The resilience contract is text you paste into your repository's root `CLAUDE.md`. It tells the coding agent which failures its code will meet, so it designs error, empty and retry states from the start. It is advice whose effect has not been measured, and it changes nothing rough-ride attacks or judges.

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

The same text ships in the package as `templates/resilience-contract.md`, under the MIT-0 licence in `templates/LICENSE`, so you can copy it without attribution.

Where to put it:

- Paste it inline in the root `CLAUDE.md`, or in `.claude/CLAUDE.md` when the repository keeps its instructions there.
- Use the root `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists at the root or in any folder you start Claude Code from. Claude Code 2.1.277 and later then reads `AGENTS.md` from the working directory and every folder above it, which the 2.1.299 floor covers. Other agents read it too.
- Never paste it in a subfolder's `CLAUDE.md` or `AGENTS.md`, which loads only on demand, possibly after the design is done; in `CLAUDE.local.md`, which is personal and git-ignored, so teammates and CI never see it; in `.claude/rules/`, because a root rules file may not load in a session started in a subfolder, and other agents never read that folder; in a separate file reached through an `@` import, which a session started in a subfolder treats as an external import and keeps off for good if the approval is declined; or as a symlink, which the docs advise against on Windows.

To update it, replace everything from the opening marker line to the closing one. To decline it, paste only the line `<!-- resilience-contract declined -->`.

- Keep it whole when `/doctor` or a prompt audit suggests trimming it.
- Edit item 2 for long uploads, exports or LLM calls; rough-ride's `settles` check still flags those flows.
- The opening paragraph describes testing that happens only where rough-ride runs. A team that drops the tool edits or deletes it.
- On Supabase or Firebase backends, "the server validates" means row-level security or security rules.

Limits: the contract asks for things no check verifies (no fallback shown as real data, untrusted responses, the error state of a page opened directly, loading states, one write after a retry that followed a timeout), so an agent can ignore those with no finding, and the server render of a page's data load is never attacked. Item 2's 10-second timeout doesn't suit streaming or long-polling requests; edit your copy.

`quick`, `standard` and `plan` look for the contract's marker lines in the root `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md` and `.claude/AGENTS.md`, and print one line when it is missing (on runs that show a finding; report.txt always has it), older than this version's edition, in a file Claude Code doesn't load, or removed on your branch. The line never changes what is attacked, the verdicts or the exit code.

## Run rough-ride on pull requests (GitHub Actions)

Copy the template below into `.github/workflows/rough-ride.yml`. Every pull request from a branch of the same repository then gets one rough-ride comment, which each push edits. A finding, a stop or a step timeout never turns the job red: only a failed checkout, setup or install does. The template ships in the package as `templates/github-actions/rough-ride.yml`, under the MIT-0 licence in `templates/LICENSE`, so you can copy it without attribution.

It is written for a Nuxt 4 + FastAPI app with `frontend/`, `backend/`, uv and SQLite. Other stacks change only the install steps and `.rough-ride/config.yaml` (see the variants below).

### Your two steps

1. **Maintainer, before the first pull request:** run `npm i -D -E rough-ride@0.1.0` in the folder that runs `npm ci`. Commit `.rough-ride/config.yaml` with `reset`, `.rough-ride/flows/sign-in.yaml`, `.rough-ride/.gitignore` and the workflow. Make `reset` (or the app) create the CI-only sign-in user from the flow's variables.
2. **Admin, once:** never add `rough-ride (non-blocking)` or `rough-ride comment` to required status checks or rulesets. Keep GitHub's default approval for first-time contributors. With the `secrets.*` variant only, add the repository secrets and the same names under Dependabot secrets.

### The workflow

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

- **Two jobs.** `attack` runs your code with a read-only token: checkout, installs, `quick` and `regress`, the upload of `.rough-ride/runs/`, and the comment text. `comment` holds only `pull-requests: write` and runs no repository code: it downloads the text and posts or edits the one comment with `gh`. A write token in `attack` would be reachable by your app and by install scripts.
- **One comment.** It edits the first comment by `github-actions[bot]` that ends with `<!-- rough-ride:pr-comment -->`, or posts one. A human comment that quotes the marker is never edited. When the attack job ended before writing its text (failed install, timeout or crash), it edits the existing comment to say so and never starts a new one. It never deletes a comment, and an API error only prints a warning.
- **Fork pull requests** get no comment: their token is read-only. The same text is in the attack job's summary under the pull request's checks. Dependabot pull requests come from the same repository and get the comment.
- **Sign-in values.** The template writes CI-only values for `DEMO_EMAIL` and `DEMO_PASSWORD` in the two runner steps' `env`, so installs and the render step never see them. These values unlock nothing outside the job, because the database dies with it. Never reuse a real password here. Use your flow's own variable names, never starting with `ROUGH_RIDE_` or `GITHUB_`.
- **Run output.** The upload keeps `.rough-ride/runs/` for 14 days, screenshots included, so a reviewer can judge a finding without running anything. report.txt evidence carries up to 200 characters of page text. In a public repository any reader can download it, which is safe only while the job uses its own data.
- **`standard` instead of `quick`:** set `RP_TIER: standard`, the tier step's `timeout-minutes: 15` and the attack job's `timeout-minutes: 40`. It costs about 3 to 4 times the minutes.

### Timeouts

Raise these by hand when `reset` is slow, `target.startTimeout` is raised or the committed tests grow.

- **Tier step:** `timeout-minutes` = ceil((`target.startTimeout` + longest `reset` + hard stop + 150 s) / 60). The hard stop is 160 s in `quick` and 490 s in `standard`. With the default `startTimeout` (120 s) and a `reset` of up to 120 s, `quick` needs 550 s, so 10 minutes, and `standard` 880 s, so 15 minutes.
- **`regress` step:** `timeout-minutes` = ceil((`target.startTimeout` + longest `reset` + 30 s × tests + 150 s) / 60), where tests counts the committed tests, at most 50. With the defaults, the template's 15 minutes cover 17 tests.
- **Jobs:** `attack` 35 minutes (install 5, tier 10, regress 15, upload and render 5), 40 with `standard`; `comment` 5.

### Keeping the pins current

Dependabot, in `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /                 # the folder whose package.json pins rough-ride
    schedule: {interval: weekly}
    cooldown: {default-days: 7}
  - package-ecosystem: github-actions
    directory: /
    schedule: {interval: weekly}
    cooldown: {default-days: 7}
```

Renovate's npm manager bumps the devDependency. A workflow-only `npx -y` pin needs a regex manager (older Renovate versions name `managerFilePatterns` `fileMatch`):

```json
{"customManagers": [{"customType": "regex", "managerFilePatterns": ["/^[.]github/workflows/rough-ride[.]ya?ml$/"], "matchStrings": ["rough-ride@(?<currentValue>[0-9]+[.][0-9]+[.][0-9]+)"], "depNameTemplate": "rough-ride", "datasourceTemplate": "npm"}]}
```

A bump across a format floor gets a comment quoting the `schema-older` stop. Apply its `upgrade.patch` on the bump branch; the Protected files block lists the pin change.

### Variants

**Postgres, MySQL or Redis.** Add a service container to the attack job (Linux runners only), pinned by digest like the actions:

```yaml
services:
  postgres:
    image: postgres:17@sha256:<digest>   # pinned by digest, like the actions
    env: {POSTGRES_USER: app, POSTGRES_PASSWORD: ci-only, POSTGRES_DB: app}   # throwaway: not secrets
    ports: ["5432:5432"]
    options: >-
      --health-cmd "pg_isready -U app -d app"
      --health-interval 2s --health-timeout 5s --health-retries 30
```

The two runner steps' `env` adds `DATABASE_URL: postgresql://app:ci-only@localhost:5432/app`, and the config's `reset` runs the app's migrations and creates the sign-in user from the flow's variables.

**docker compose, for backing services only.** A step before the tier step runs `docker compose -f compose.yaml up --detach --wait db redis`, and a last step with `if: always()` runs `docker compose -f compose.yaml down --volumes`. Keep the dev servers under `--start`: a dev server inside a container fails rough-ride's same-folder check.

**Real credentials (`secrets.*`),** for a sign-in that writes to an allowed remote host, where the password is real: set `DEMO_PASSWORD: ${{ secrets.DEMO_PASSWORD }}` in the two runner steps' `env`, still at step level, and add the line `!.rough-ride/runs/**/*.png` under the upload's `path` to leave screenshots out. An Admin adds the repository secrets and the same names under Dependabot secrets. Fork pull requests then stop within seconds with a missing-variable line, and so do Dependabot ones without the Dependabot secrets.

**A `frontend/` with its own lockfile.** In the install step, run `npm ci --prefix frontend` and leave `uv sync --project backend --locked` as it is. Both runner steps and the render step set `working-directory: frontend`, and setup-node sets `cache-dependency-path: frontend/package-lock.json`. The upload path stays `.rough-ride/runs/`, because `uses:` steps ignore `working-directory`.

**No `package.json`** (server-rendered Python, Ruby or Go): keep setup-node, drop `npm ci`, and run `exec npx -y rough-ride@0.1.0 quick --start --json`, with the same form for `regress` and `pr-comment`. The config gives `target.url` and `target.start`.

**pnpm.** Add a `pnpm/action-setup` step before setup-node, pinned by full commit SHA with its release in a comment like the other actions, set setup-node's `cache: pnpm`, install with `pnpm install --frozen-lockfile` and run `exec pnpm exec rough-ride ...`.

**Yarn 2 or later.** Run `corepack enable` before setup-node with `cache: yarn`, install with `yarn install --immutable` and run `exec yarn rough-ride ...`.

**Checkout into a folder (`path: <dir>`).** Set `defaults.run.working-directory: <dir>`, and add `<dir>/` to the upload path, `cache-dependency-path` and the uv project.

**Container jobs** are not the documented path. One that needs a container adds, right after checkout, a step that runs `git config --global --add safe.directory "$GITHUB_WORKSPACE"`, plus a browser step (below), and makes `localhost` reach Nuxt's `::1` bind.

**Runners with no browser** (`ubuntu-24.04-arm`, self-hosted runners, containers). Add an `actions/cache` step on `~/.cache/ms-playwright`, pinned by full commit SHA, keyed `ms-playwright-${{ runner.os }}-${{ runner.arch }}-<playwright-core version>`. On a cache miss, a step runs `node "<playwright-core folder>/cli.js" install --no-shell --no-remove chromium`, where the folder is that of `require.resolve('playwright-core/package.json', {paths: [<rough-ride folder>]})`. Container jobs can use `mcr.microsoft.com/playwright:v<that version>-noble` instead. The version is the Playwright that rough-ride pins, printed on the comment's `Runner:` line.

**Vite cache fallback.** If runs log `dev server reloaded during <n> flow runs` from a cold dependency cache, restore `<nuxt root>/node_modules/.cache/vite` with a SHA-pinned `actions/cache` step after `npm ci`, keyed on a hash of the lockfile and `nuxt.config.*`.

**Other stacks.** Nuxt or Vite with a Node API drops the uv steps. Next.js does too, and its frontend files read `not traced`. macOS and Windows runners run the steps unchanged under `shell: bash` but are not the documented path: `services:` is Linux-only, and on Windows a step timeout leaves no summary.

### Limits

- CI runs no adversary: it attacks only through committed flows and tests, so untraced files stay `not traced` and pages no flow reaches stay unattacked.
- Each push starts the app twice, and reached tests run in both the tier and `regress`. Docs-only pull requests pay for that too.
- Private repositories' 2-vCPU runners get 2 lanes, so more of the tail can read `over the quick budget (time)`, and it varies between pushes.
- Hosted Chrome changes with each runner image, so verdicts can shift between image updates.
- A same-repository pull request runs its own copy of the workflow, so it can change or forge its comment; review the diff.
- Pull requests with merge conflicts, base changes and the draft-to-ready switch get no new run, so the comment shows the last push.
- The lookup matches comments by `github-actions[bot]`. A team posting with an App token changes that filter.
- Steps with findings carry GitHub's "Process completed with exit code 1" annotation while the job stays green.
- GitHub Enterprise Server is unsupported, because the artifact actions need v4 or later.

## What rough-ride writes into your repo

Flows, repros, regression tests and the `.rough-ride/.gitignore` it writes belong to you and carry no licence header. It never writes CLAUDE.md, AGENTS.md or anything under .claude/. The resilience contract is text you add yourself.

## Licence

Copyright 2026 the rough-ride maintainers. Licensed under Apache-2.0.
