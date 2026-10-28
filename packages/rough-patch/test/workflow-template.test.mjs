import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { docsFiles, pinProblems } from '../../../scripts/docs-pins.mjs';
import { npmPack } from '../../../scripts/pack-contents.mjs';
import { commentScript, readmeProblems, readmeTemplateBlock, runCommentScript, SECTION, TEMPLATE, templateProblems, templateShasProblems } from '../../../scripts/workflow-template.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const template = read(TEMPLATE);
const readme = read('README.md');
const own = Object.fromEntries(readdirSync(path.join(ROOT, '.github', 'workflows')).map((f) => [`.github/workflows/${f}`, read(`.github/workflows/${f}`)]));
const MARKER = '<!-- rough-patch:pr-comment -->';
const has = (problems, re) => assert.ok(problems.some((p) => re.test(p)), problems.join('\n') || 'no problems');

// The template with one exact piece of text replaced; fails if the piece is missing.
function edit(from, to) {
  assert.ok(template.includes(from), `the template has no ${JSON.stringify(from)}`);
  return template.replace(from, to);
}

test('the shipped template passes the static checks and template-shas, and both READMEs carry it byte for byte', () => {
  assert.deepEqual(templateProblems(template), []);
  assert.deepEqual(templateShasProblems(template, own), []);
  for (const f of ['README.md', 'packages/rough-patch/README.md']) assert.deepEqual(readmeProblems(f, read(f), Buffer.from(template)), [], f);
  assert.equal(readmeTemplateBlock(readme), template);
  assert.doesNotMatch(template, /<sha>|\u2014/);
});

test('docs-pins passes the repository and fails a uses: line not pinned as owner/repo@<40 hex> # vN', () => {
  const files = docsFiles(ROOT);
  for (const f of ['README.md', 'packages/rough-patch/README.md', 'packages/rough-patch/templates/github-actions/rough-patch.yml']) assert.ok(files.includes(f), f);
  assert.deepEqual(files.flatMap((f) => pinProblems(f, read(f))), []);
  const sha = 'cf430e030ddbb5b0abf93d22962f4752f3646cd9';
  for (const ok of [`uses: actions/upload-artifact@${sha} # v7.0.2`, `      - uses: github/codeql-action/init@${sha} # v4`, `        uses: a/b@${sha} # v1 the release`]) assert.deepEqual(pinProblems('x.md', ok), [], ok);
  for (const bad of ['uses: actions/cache@v4', `uses: actions/cache@${sha}`, `uses: actions/cache@${sha} # main`, `uses: actions/cache@${sha.slice(0, 7)} # v4`, 'uses: actions/checkout@<sha> # v7', `uses: ./local@${sha} # v1`, 'uses: docker://alpine:3']) {
    has(pinProblems('docs/x.md', `steps:\n  - ${bad}\n`), /^docs\/x\.md:2: uses: .* is not pinned as owner\/repo@<40 hex> # vN$/);
  }
  // Prose that names `uses:` mid-line is not a uses: line.
  assert.deepEqual(pinProblems('README.md', 'The upload path stays put, because `uses:` steps ignore `working-directory`.'), []);
});

test('template-shas fails a pin at another SHA or release than rough-patch\'s own workflows, or an action they don\'t pin', () => {
  const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
  has(templateShasProblems(edit(checkout, 'actions/checkout@0000000000000000000000000000000000000000 # v7.0.1'), own), /actions\/checkout@0{40} # v7\.0\.1 differs from \.github\/workflows\/ci\.yml:\d+'s 3d3c42e5/);
  has(templateShasProblems(edit(checkout, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.2'), own), /differs from/);
  has(templateShasProblems(`${template}      - uses: actions/cache@3d3c42e5aac5ba805825da76410c181273ba90b1 # v5\n`, own), /actions\/cache is not pinned in \.github\/workflows\/, so its SHA is unchecked/);
  // A mismatched pin without its release comment, or quoted, is reported rather than skipped.
  const unparsed = /rough-patch\.yml:\d+: uses: .*actions\/checkout@0{40}.* is not pinned as owner\/repo@<40 hex> # vN, so its SHA is unchecked$/;
  has(templateShasProblems(edit(checkout, 'actions/checkout@0000000000000000000000000000000000000000'), own), unparsed);
  has(templateShasProblems(edit(checkout, '"actions/checkout@0000000000000000000000000000000000000000" # v7.0.1'), own), unparsed);
});

test('static checks: permissions, ${{ in run:, the CI-only variables, the trigger and continue-on-error', () => {
  has(templateProblems(edit('permissions: {}', 'permissions:\n  contents: read')), /top-level permissions are not \{\}/);
  has(templateProblems(edit('      contents: read\n', '      contents: read\n      pull-requests: write\n')), /attack job holds other permissions than contents: read/);
  has(templateProblems(edit('      pull-requests: write  ', '      contents: read\n      pull-requests: write  ')), /comment job holds other permissions than pull-requests: write/);
  has(templateProblems(edit('  comment:\n', '  extra:\n    runs-on: ubuntu-24.04\n    permissions: write-all\n    steps: [{run: "true"}]\n  comment:\n')), /a job extra; only attack and comment/);
  has(templateProblems(edit('mkdir -p "$out"', 'mkdir -p "$out" "${{ github.head_ref }}"')), /run: block in attack \(Write the comment and the job summary\) contains \$\{\{/);
  has(templateProblems(edit('  RP_TIER: quick', '  DEMO_PASSWORD: demo-password\n  RP_TIER: quick')), /DEMO_PASSWORD appears outside the two runner steps' env/);
  has(templateProblems(edit('          ARTIFACT_URL:', '          SAMPLE_DB: x\n          ARTIFACT_URL:')), /SAMPLE_DB appears outside/);
  has(templateProblems(edit('          mkdir -p "$out"\n', '          mkdir -p "$out"\n          echo "$DEMO_EMAIL"\n')), /DEMO_EMAIL appears outside/);
  has(templateProblems(edit('          DEMO_EMAIL: demo@example.com\n          DEMO_PASSWORD: demo-password\n          SAMPLE_DB: ${{ runner.temp }}/app.db\n        run', '          SAMPLE_DB: ${{ runner.temp }}/app.db\n        run')), /DEMO_EMAIL appears outside the two runner steps' env, or not in both/);
  has(templateProblems(edit('on:\n  pull_request:\n', 'on:\n  pull_request:\n  pull_request_target:\n')), /the triggers are pull_request, pull_request_target/);
  has(templateProblems(edit('on:\n  pull_request:\n', 'on:\n  workflow_run:\n    workflows: [ci]\n')), /the triggers are workflow_run/);
  has(templateProblems(edit('on:\n  pull_request:\n', 'on:\n  pull_request:\n    paths: ["frontend/**"]\n')), /pull_request has a filter: paths/);
  has(templateProblems(edit('        continue-on-error: true      # findings, stops and step timeouts never fail the job\n', '')), /rough-patch \$\{\{ env\.RP_TIER \}\} does not set continue-on-error: true/);
  has(templateProblems(edit('        continue-on-error: true\n        timeout-minutes: 15\n', '        timeout-minutes: 15\n')), /rough-patch regress does not set continue-on-error/);
  has(templateProblems(edit('        continue-on-error: true      # a pr-comment exit', '        continue-on-error: false     # a pr-comment exit')), /Write the comment and the job summary does not set continue-on-error/);
  has(templateProblems(edit('        id: install\n', '        id: install\n        continue-on-error: true\n')), /Install the app and the pinned rough-patch sets continue-on-error/);
  has(templateProblems(edit('      - name: Set up uv\n', '      - name: Set up uv\n        continue-on-error: true\n')), /Set up uv sets continue-on-error/);
  has(templateProblems(edit('      - name: Check out the pull request with full history\n', '      - name: Check out the pull request with full history\n        continue-on-error: true\n')), /Check out the pull request with full history sets continue-on-error/);
  has(templateProblems('jobs: [unclosed'), /not YAML/);
});

test('a one-byte change to a README copy, or a missing section, fails template-checks', () => {
  const tpl = Buffer.from(template);
  has(readmeProblems('README.md', readme.replace('timeout-minutes: 35 ', 'timeout-minutes: 36 '), tpl), /^README\.md's fenced copy differs from packages\/rough-patch\/templates\/github-actions\/rough-patch\.yml$/);
  has(readmeProblems('README.md', readme.replace(SECTION, '## GitHub Actions'), tpl), /has no fenced yaml block under/);
});

test('the README section carries the two steps, the timeout formulas, the Dependabot and Renovate snippets and every variant', () => {
  const start = readme.indexOf(SECTION);
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
  assert.match(section, /1\. \*\*Maintainer, before the first pull request:\*\* run `npm i -D -E rough-patch@\d+\.\d+\.\d+`/);
  assert.match(section, /2\. \*\*Admin, once:\*\* never add `rough-patch \(non-blocking\)` or `rough-patch comment` to required status checks or rulesets/);
  assert.match(section, /ceil\(\(`target\.startTimeout` \+ longest `reset` \+ hard stop \+ 150 s\) \/ 60\)/);
  assert.match(section, /`quick` needs 550 s, so 10 minutes, and `standard` 880 s, so 15 minutes/);
  assert.match(section, /ceil\(\(`target\.startTimeout` \+ longest `reset` \+ 30 s × tests \+ 150 s\) \/ 60\), where tests counts the committed tests, at most 50/);
  assert.match(section, /15 minutes cover 17 tests/);
  assert.match(section, /package-ecosystem: github-actions/);
  assert.match(section, /"customType": "regex"/);
  assert.match(section, /These values unlock nothing outside the job, because the database dies with it\. Never reuse a real password here\./);
  for (const variant of ['Postgres, MySQL or Redis', 'docker compose', 'Real credentials (`secrets.*`)', 'A `frontend/` with its own lockfile', 'No `package.json`', 'pnpm', 'Yarn 2 or later', 'Checkout into a folder (`path: <dir>`)', 'Container jobs', 'Runners with no browser', 'Vite cache fallback']) {
    assert.ok(section.includes(`**${variant}`), variant);
  }
  // The frontend/ variant moves only npm ci, because the install step also holds the uv sync.
  assert.match(template, /run: \|\n {10}npm ci .*\n {10}uv sync --project backend --locked /);
  assert.match(section, /\*\*A `frontend\/` with its own lockfile\.\*\* In the install step, run `npm ci --prefix frontend` and leave `uv sync --project backend --locked` as it is\. Both runner steps and the render step set `working-directory: frontend`/);
  assert.doesNotMatch(section, /`npm ci`, both runner steps and the render step set `working-directory/);
  assert.ok(section.includes('!.rough-patch/runs/**/*.png'));
  assert.doesNotMatch(section, /\u2014/);
});

test('ci.yml runs docs-pins, template-shas, template-checks with the mocked-gh tests, and actionlint on the template', () => {
  const jobs = YAML.parse(own['.github/workflows/ci.yml']).jobs;
  const runs = (name) => (jobs[name]?.steps ?? []).map((s) => s.run ?? '').join('\n');
  assert.match(runs('docs-pins'), /node scripts\/docs-pins\.mjs/);
  assert.match(runs('template-shas'), /node scripts\/workflow-template\.mjs template-shas/);
  assert.match(runs('template-checks'), /node scripts\/workflow-template\.mjs template-checks/);
  assert.match(runs('template-checks'), /node --test packages\/rough-patch\/test\/workflow-template\.test\.mjs/);
  assert.match(runs('actionlint'), /actionlint\S* .*packages\/rough-patch\/templates\/github-actions\/rough-patch\.yml/);
});

test('the packed tarball holds the workflow template under the templates/ licence', () => {
  const files = npmPack(fileURLToPath(new URL('..', import.meta.url))).files.map((f) => f.path);
  for (const f of ['templates/github-actions/rough-patch.yml', 'templates/LICENSE']) assert.ok(files.includes(f), f);
  assert.match(read('packages/rough-patch/templates/LICENSE'), /^MIT No Attribution/);
});

// The comment job's script (53.5) runs under bash with a mocked gh. The job runs on
// ubuntu-24.04 only, so Windows skips; so does a machine with no bash or jq.
const tools = ['bash', 'jq'].every((t) => spawnSync(t, ['--version']).status === 0);
const skip = process.platform === 'win32' ? 'the comment job runs on Linux only' : tools ? false : 'needs bash and jq';
const script = commentScript(template);
const body = `rough-patch quick | 1 finding | commit 9c1e0aa | non-blocking\n\nDetails.\n${MARKER}\n`;
const bot = (id, text) => ({ id, user: { login: 'github-actions[bot]' }, body: text });
const human = (id, text) => ({ id, user: { login: 'octocat' }, body: text });
const writes = (r) => r.calls.filter((c) => c.args.includes('--method'));
const lists = (r) => r.calls.filter((c) => c.args.includes('--paginate'));
const sent = (call) => JSON.parse(call.stdin).body;

test('mocked gh: a missing, empty, marker-less or oversized body with no existing comment posts nothing', { skip }, () => {
  for (const b of [null, '', 'rough-patch quick | passed\n', `${'x'.repeat(60_001)}\n${MARKER}\n`]) {
    const r = runCommentScript({ script, body: b });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lists(r).length, 1);
    assert.deepEqual(writes(r), [], String(b).slice(0, 40));
    assert.equal(r.stdout, '');
  }
});

test('mocked gh: an existing marker comment by github-actions[bot] is PATCHed, with the body or the fallback body', { skip }, () => {
  const comments = [human(1, 'Looks good'), bot(2, 'from another workflow'), bot(3, `old text\n${MARKER}\n \n`), bot(4, `later\n${MARKER}`)];
  const r = runCommentScript({ script, body, comments });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lists(r)[0].args, ['api', '--paginate', 'repos/acme/shop/issues/7/comments', '--jq', lists(r)[0].args[4]]);
  assert.equal(writes(r).length, 1);
  assert.deepEqual(writes(r)[0].args, ['api', '--method', 'PATCH', 'repos/acme/shop/issues/comments/3', '--input', '-']);
  assert.equal(sent(writes(r)[0]), body);

  const fallback = runCommentScript({ script, body: null, comments, tier: 'standard' });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.deepEqual(writes(fallback).map((c) => c.args[3]), ['repos/acme/shop/issues/comments/3']);
  assert.equal(
    sent(writes(fallback)[0]),
    `rough-patch standard | did not report | commit 9c1e0aa | non-blocking\n\nThe job ended before rough-patch wrote its comment (failed install, timeout or crash). [Job log](https://github.com/acme/shop/actions/runs/123)\n${MARKER}\n`,
  );
});

test('mocked gh: a human comment ending with the marker is never edited', { skip }, () => {
  const comments = [human(8, `I quote it:\n${MARKER}`)];
  const posted = runCommentScript({ script, body, comments });
  assert.equal(posted.status, 0, posted.stderr);
  assert.deepEqual(writes(posted).map((c) => c.args.slice(1, 4)), [['--method', 'POST', 'repos/acme/shop/issues/7/comments']]);
  assert.equal(sent(writes(posted)[0]), body);
  const none = runCommentScript({ script, body: null, comments });
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(writes(none), []);
});

test('mocked gh: a valid body and no rough-patch comment POSTs one', { skip }, () => {
  const r = runCommentScript({ script, body, comments: [bot(9, 'another bot comment')] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(writes(r).map((c) => c.args[2]), ['POST']);
  assert.equal(sent(writes(r)[0]), body);
});

test('mocked gh: a failed lookup posts nothing and the step exits 0; a failed PATCH or POST warns and exits 0', { skip }, () => {
  const r = runCommentScript({ script, body, comments: [bot(3, `old\n${MARKER}`)], listFails: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(writes(r), []);
  assert.equal(r.stdout, "::warning title=rough-patch::Could not read this pull request's comments; the attack job's summary has the text.\n");
  const patch = runCommentScript({ script, body, comments: [bot(3, `old\n${MARKER}`)], writeFails: true });
  assert.equal(patch.status, 0, patch.stderr);
  assert.match(patch.stdout, /^::warning title=rough-patch::Could not update the comment; the attack job's summary has the text\.\n$/);
  const post = runCommentScript({ script, body, writeFails: true });
  assert.equal(post.status, 0, post.stderr);
  assert.match(post.stdout, /^::warning title=rough-patch::Could not post the comment; the attack job's summary has the text\.\n$/);
});
