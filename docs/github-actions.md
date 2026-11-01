# GitHub Actions: details

The workflow itself is in the [README](../README.md#run-rough-ride-on-pull-requests-github-actions) and ships as `templates/github-actions/rough-ride.yml`.

It is written for a Nuxt 4 + FastAPI app with `frontend/`, `backend/`, uv and SQLite. Other stacks change only the install steps and `.rough-ride/config.yaml` (see the variants below).

## Who does what

1. **Maintainer, before the first pull request:** run `npm i -D -E rough-ride@0.1.0` in the folder that runs `npm ci`. Commit `.rough-ride/config.yaml` with `reset`, `.rough-ride/flows/sign-in.yaml`, `.rough-ride/.gitignore` and the workflow. Make `reset` (or the app) create the CI-only sign-in user from the flow's variables.
2. **Admin, once:** never add `rough-ride (non-blocking)` or `rough-ride comment` to required status checks or rulesets. Keep GitHub's default approval for first-time contributors. With the `secrets.*` variant only, add the repository secrets and the same names under Dependabot secrets.

## Notes on the workflow

- **Two jobs.** `attack` runs your code with a read-only token: checkout, installs, `quick` and `regress`, the upload of `.rough-ride/runs/`, and the comment text. `comment` holds only `pull-requests: write` and runs no repository code: it downloads the text and posts or edits the one comment with `gh`. A write token in `attack` would be reachable by your app and by install scripts.
- **One comment.** It edits the first comment by `github-actions[bot]` that ends with `<!-- rough-ride:pr-comment -->`, or posts one. A human comment that quotes the marker is never edited. When the attack job ended before writing its text (failed install, timeout or crash), it edits the existing comment to say so and never starts a new one. It never deletes a comment, and an API error only prints a warning.
- **Fork pull requests** get no comment: their token is read-only. The same text is in the attack job's summary under the pull request's checks. Dependabot pull requests come from the same repository and get the comment.
- **Sign-in values.** The template writes CI-only values for `DEMO_EMAIL` and `DEMO_PASSWORD` in the two runner steps' `env`, so installs and the render step never see them. These values unlock nothing outside the job, because the database dies with it. Never reuse a real password here. Use your flow's own variable names, never starting with `ROUGH_RIDE_` or `GITHUB_`.
- **Run output.** The upload keeps `.rough-ride/runs/` for 14 days, screenshots included, so a reviewer can judge a finding without running anything. report.txt evidence carries up to 200 characters of page text. In a public repository any reader can download it, which is safe only while the job uses its own data.
- **`standard` instead of `quick`:** set `RP_TIER: standard`, the tier step's `timeout-minutes: 15` and the attack job's `timeout-minutes: 40`. It costs about 3 to 4 times the minutes.

## Timeouts

Raise these by hand when `reset` is slow, `target.startTimeout` is raised or the committed tests grow.

- **Tier step:** `timeout-minutes` = ceil((`target.startTimeout` + longest `reset` + hard stop + 150 s) / 60). The hard stop is 160 s in `quick` and 490 s in `standard`. With the default `startTimeout` (120 s) and a `reset` of up to 120 s, `quick` needs 550 s, so 10 minutes, and `standard` 880 s, so 15 minutes.
- **`regress` step:** `timeout-minutes` = ceil((`target.startTimeout` + longest `reset` + 30 s × tests + 150 s) / 60), where tests counts the committed tests, at most 50. With the defaults, the template's 15 minutes cover 17 tests.
- **Jobs:** `attack` 35 minutes (install 5, tier 10, regress 15, upload and render 5), 40 with `standard`; `comment` 5.

## Keeping the pins current

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

## Variants

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

## Limits

- CI runs no adversary: it attacks only through committed flows and tests, so untraced files stay `not traced` and pages no flow reaches stay unattacked.
- Each push starts the app twice, and reached tests run in both the tier and `regress`. Docs-only pull requests pay for that too.
- Private repositories' 2-vCPU runners get 2 lanes, so more of the tail can read `over the quick budget (time)`, and it varies between pushes.
- Hosted Chrome changes with each runner image, so verdicts can shift between image updates.
- A same-repository pull request runs its own copy of the workflow, so it can change or forge its comment; review the diff.
- Pull requests with merge conflicts, base changes and the draft-to-ready switch get no new run, so the comment shows the last push.
- The lookup matches comments by `github-actions[bot]`. A team posting with an App token changes that filter.
- Steps with findings carry GitHub's "Process completed with exit code 1" annotation while the job stays green.
- GitHub Enterprise Server is unsupported, because the artifact actions need v4 or later.
