import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadDoc, MARKER, renderComment } from '../dist/prcomment.mjs';
import { fixture, run, scratchDir } from './helpers.mjs';

const OWN = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const load = (name) => JSON.parse(readFileSync(fixture(`prcomment/${name}`), 'utf8'));
const TIER = load('tier.json');
const REGRESS = load('regress.json');
const RUNNER = 'Runner: rough-patch 0.1.0 from devDependency package.json | Node 22.23.3 | Playwright 1.64.1';
const NO_GITHUB = { GITHUB_ACTIONS: '', GITHUB_EVENT_PATH: '', GITHUB_SHA: '', GITHUB_SERVER_URL: '', GITHUB_REPOSITORY: '', GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: '' };

// A document built from the sample's, with sections kept in step with summaryLines.
const doc = (base, over = {}) => {
  const d = { ...structuredClone(base), ...structuredClone(over) };
  d.summaryLines = d.sections.flatMap((s) => s.lines);
  return d;
};
const tierDoc = (over) => doc(TIER, over);
const regressDoc = (over) => doc(REGRESS, over);
const L = (d) => ({ kind: 'doc', doc: d });
const NONE = { kind: 'none' };

const bodies = [];
const render = (tier, regress, { env = {}, artifactUrl = null, name = 'quick' } = {}) => {
  const body = renderComment({ tier: name, tierDoc: tier, regressDoc: regress, own: OWN, env, artifactUrl });
  bodies.push(body);
  return body;
};
const line1 = (body) => body.split('\n')[0];

const regressCounts = (over) => ({ pass: 0, fail: 0, flaky: 0, stale: 0, overLimit: 0, tests: [], ...over });
const regressRun = (counts, extra = {}) =>
  regressDoc({
    runId: '20261027-190000-regress-ab12',
    status: counts.fail > 0 ? 'findings' : counts.overLimit > 0 ? 'incomplete' : 'passed',
    regress: regressCounts(counts),
    sections: [
      { id: 'header', lines: ['rough-patch regress | 41s | run 20261027-190000-regress-ab12'] },
      { id: 'after', lines: ['Regression tests: see the counts'] },
      { id: 'runner', lines: [RUNNER] },
    ],
    ...extra,
  });

const stopDoc = (base, { code, lines, runId, header }) =>
  doc(base, {
    status: 'stopped',
    exitCode: 1,
    runId,
    stop: { kind: 'stop', code, lines },
    findings: [],
    regress: null,
    sections: [
      { id: 'header', lines: [header] },
      { id: 'stop', lines },
      { id: 'runner', lines: [RUNNER] },
    ],
  });

// Weakening first, then CI inputs, then the rest, as protected.mts orders them.
const entry = (p, over = {}) => ({ path: p, kind: 'flow', change: 'steps changed', weakening: false, by: null, used: 'working-tree', notApplied: [], ...over });
const withProtected = (base, entries, heading = 'Protected files changed since origin/main (3f2a91c):') =>
  doc(base, {
    protected: entries,
    protectedLines: [heading, ...entries.map((e) => `  ${e.path}: ${e.change} -> applied`)],
    sections: [
      ...base.sections.slice(0, 1),
      { id: 'protected', lines: [`Protected files: ${entries.length} changes since origin/main, used as written (report.txt)`] },
      ...base.sections.slice(1),
    ],
  });

test('the sample quick and regress documents render the passed body exactly', () => {
  const body = render(L(tierDoc()), L(regressDoc()), { env: NO_GITHUB });
  assert.equal(
    body,
    [
      'rough-patch quick | no findings | non-blocking',
      '',
      '```text',
      'rough-patch quick | 15m29s | run 20261027-184640-quick-hkhw | 0.x pre-release: detection and false-alarm rates not measured yet',
      'diff: main 03342ce..working tree | 1 file -> 1 flow, 1 form',
      'target: http://localhost:3731 (proven Nuxt dev server) | API http://localhost:8731 | Chrome 156.0.8078.48',
      "Protected files compared with local main (no remote). Commits on main count as reviewed, so rough-patch can't tell your commits there from an agent's.",
      'target unstable during 3 flow runs; flow runs went one at a time from then on',
      'Over the quick budget by 13m28s: flow runs still going at 2m00s were allowed to finish.',
      'Attacks: 1 of 1 changed file attacked | 4 attacks: 1 passed, 3 not judged | 2 skipped',
      'Full report: .rough-patch/runs/20261027-184640-quick-hkhw/report.txt',
      RUNNER,
      '```',
      MARKER,
      '',
    ].join('\n'),
  );
});

test('the tier verdict comes from status alone', () => {
  const group = { severity: 'MED' };
  const cases = [
    [{ status: 'findings', findings: [group] }, '1 finding'],
    [{ status: 'findings', findings: [group, group, group] }, '3 findings'],
    [{ status: 'findings', findings: [], regress: regressCounts({ fail: 1 }) }, '0 findings, 1 regression test failed'],
    [{ status: 'findings', findings: [], regress: regressCounts({ fail: 2, pass: 1 }) }, '0 findings, 2 regression tests failed'],
    [{ status: 'passed' }, 'no findings'],
    [{ status: 'incomplete' }, 'no findings, incomplete'],
    [{ status: 'nothing-to-attack' }, 'nothing to attack'],
    [{ status: 'nothing-attacked' }, 'nothing attacked'],
    [{ status: 'stopped', stop: { kind: 'stop', code: 'git-failed', lines: ['x'] } }, 'stopped (git-failed)'],
    [{ status: 'interrupted' }, 'interrupted'],
    [{ status: 'internal-error' }, 'internal error'],
  ];
  for (const [over, verdict] of cases) {
    assert.equal(line1(render(L(tierDoc(over)), L(regressDoc()), { env: NO_GITHUB })), `rough-patch quick | ${verdict} | non-blocking`, JSON.stringify(over));
  }
  assert.equal(line1(render(L(tierDoc({ status: 'passed' })), L(regressDoc()), { env: NO_GITHUB, name: 'standard' })), 'rough-patch standard | no findings | non-blocking');
});

test('the regress verdict: all passed, the failed form, left out with no tests, and its own stops', () => {
  const verdict = (r) => line1(render(L(tierDoc()), L(r), { env: NO_GITHUB })).split(' | ').slice(2, -1).join(' | ');
  assert.equal(verdict(regressRun({ pass: 4 })), 'regression tests: 4 passed');
  assert.equal(verdict(regressRun({ pass: 1, fail: 2, flaky: 1, stale: 1, overLimit: 3 })), 'regression tests: 2 failed, 1 flaky, 1 stale, 3 over the limit of 8');
  assert.equal(verdict(regressRun({ pass: 3, fail: 1 })), 'regression tests: 1 failed of 4');
  assert.equal(verdict(regressRun({ pass: 2, stale: 1 })), 'regression tests: 0 failed, 1 stale of 3');
  assert.equal(verdict(regressRun({ pass: 50, overLimit: 1 })), 'regression tests: 0 failed, 1 over the limit of 51');
  assert.equal(verdict(regressDoc()), '');
  assert.equal(verdict(regressDoc({ status: 'interrupted', regress: null })), 'regress interrupted');
  assert.equal(verdict(regressDoc({ status: 'internal-error', regress: null })), 'regress internal error');
  const stop = stopDoc(REGRESS, { code: 'browser-missing', lines: ['No Chrome found.'], runId: null, header: 'rough-patch regress | 0.1s | stopped' });
  assert.equal(verdict(stop), 'regress stopped (browser-missing)');
  // A tier that stopped differently does not count as the same way.
  const tierStop = stopDoc(TIER, { code: 'browser-missing', lines: ['No Chrome found at all.'], runId: null, header: 'rough-patch quick | 0.1s | stopped' });
  assert.equal(line1(render(L(tierStop), L(stop), { env: NO_GITHUB })), 'rough-patch quick | stopped (browser-missing) | regress stopped (browser-missing) | non-blocking');
  assert.equal(line1(render(L(tierDoc()), NONE, { env: NO_GITHUB })), 'rough-patch quick | no findings | regress: no summary | non-blocking');
});

test('the regress block is left out when regress passed or had no tests, and shown otherwise without a repeated runner line', () => {
  const passed = render(L(tierDoc()), L(regressRun({ pass: 4 })), { env: NO_GITHUB });
  assert.equal(passed.includes('rough-patch regress |'), false);
  const none = render(L(tierDoc()), L(regressDoc()), { env: NO_GITHUB });
  assert.equal(none.includes('No regression tests'), false);
  const failed = render(L(tierDoc()), L(regressRun({ pass: 3, fail: 1 })), { env: NO_GITHUB });
  assert.match(failed, /```\n\n```text\nrough-patch regress \| 41s \| run 20261027-190000-regress-ab12\nRegression tests: see the counts\n```\n<!--/);
  assert.equal(failed.split(RUNNER).length - 1, 1);
  const otherRunner = regressRun({ pass: 3, fail: 1 }, { sections: [{ id: 'header', lines: ['rough-patch regress | 41s'] }, { id: 'runner', lines: ['Runner: rough-patch 0.1.0 from npx | Node 22.23.3 | Playwright 1.64.1'] }] });
  assert.match(render(L(tierDoc()), L(otherRunner), { env: NO_GITHUB }), /rough-patch regress \| 41s\nRunner: rough-patch 0\.1\.0 from npx/);
});

test('two schema-older stops that differ only by their own run ids stopped the same way, and the regress block is left out', () => {
  const lines = (id) => [
    'rough-patch 0.8.0 no longer reads the format of 13 files (flows changed in 0.8.0, config in 0.7.0):',
    '  .rough-patch/config.yaml             schema: 0.5.0',
    '  .rough-patch/flows/create-note.yaml  schema: 0.5.0',
    `  ... and 11 more (all listed in ${id}/upgrade.txt in the job's uploaded run output)`,
    `This ran in CI: take ${id}/upgrade.patch from the job's uploaded run output and apply it at the repository root with git apply, or run rough-patch 0.8.0 locally to get the same patch.`,
    'Release notes: https://github.com/rough-patch/rough-patch/releases/tag/v0.8.0',
  ];
  const tierId = '20261026-101207-quick-a1b2';
  const regressId = '20261026-101215-regress-c3d4';
  const tier = stopDoc(TIER, { code: 'schema-older', lines: lines(tierId), runId: tierId, header: `rough-patch quick | 0.6s | run ${tierId} | stopped` });
  const regress = stopDoc(REGRESS, { code: 'schema-older', lines: lines(regressId), runId: regressId, header: `rough-patch regress | 0.4s | run ${regressId} | stopped` });
  const body = render(L(tier), L(regress), { env: { ...NO_GITHUB, GITHUB_SHA: '9c1e0aa5d2f0c0ffee00000000000000000000aa' } });
  assert.equal(
    body,
    [
      'rough-patch quick | stopped (schema-older) | regress stopped the same way | commit 9c1e0aa | non-blocking',
      '',
      '```text',
      `rough-patch quick | 0.6s | run ${tierId} | stopped`,
      ...lines(tierId),
      RUNNER,
      '```',
      MARKER,
      '',
    ].join('\n'),
  );
  // Another document's run id is not a placeholder: the tier's id in regress's lines differs.
  const crossed = stopDoc(REGRESS, { code: 'schema-older', lines: lines(tierId), runId: regressId, header: 'rough-patch regress | 0.4s | stopped' });
  assert.equal(line1(render(L(tier), L(crossed), { env: NO_GITHUB })), 'rough-patch quick | stopped (schema-older) | regress stopped (schema-older) | non-blocking');
});

test('missing, empty, non-JSON and other-version documents', () => {
  const dir = scratchDir();
  const write = (name, content) => {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  };
  const missing = path.join(dir, 'missing.json');
  const empty = write('empty.json', '');
  const garbage = write('garbage.json', 'rough-patch quick | stopped\n');
  const two = write('two.json', '{}\n{}\n');
  const other = write('other.json', JSON.stringify(tierDoc({ runner: { version: '0.2.0' } })));
  const major = write('major.json', JSON.stringify(tierDoc({ runner: { version: '1.0.0' } })));
  for (const file of [missing, empty, garbage, two]) assert.deepEqual(loadDoc(file, OWN), { kind: 'none' }, file);
  assert.deepEqual(loadDoc(other, '0.1.0'), { kind: 'unreadable', version: '0.2.0' });
  assert.deepEqual(loadDoc(major, '0.1.0'), { kind: 'unreadable', version: '1.0.0' });
  assert.equal(loadDoc(write('later.json', JSON.stringify(tierDoc({ runner: { version: '1.4.0' } }))), '1.2.3').kind, 'doc');

  const noTier = render(NONE, L(regressDoc()), { env: NO_GITHUB });
  assert.equal(
    noTier,
    ['rough-patch quick | no summary | non-blocking', '', 'rough-patch quick wrote no summary: its step ended first (step timeout, cancel or crash). See the job log.', MARKER, ''].join('\n'),
  );
  const noRegress = render(L(tierDoc()), NONE, { env: NO_GITHUB });
  assert.match(noRegress, /```\n\nrough-patch regress wrote no summary: its step ended first \(step timeout, cancel or crash\)\. See the job log\.\n<!-- rough-patch:pr-comment -->\n$/);
  const unreadable = render(loadDoc(other, OWN), L(regressDoc()), { env: NO_GITHUB });
  assert.equal(line1(unreadable), `rough-patch quick | unreadable summary (written by rough-patch 0.2.0; this is ${OWN}) | non-blocking`);
});

test('UTF-16LE with a BOM, and UTF-8 with a BOM, read the same as UTF-8', () => {
  const dir = scratchDir();
  const text = JSON.stringify(tierDoc());
  const utf8 = path.join(dir, 'utf8.json');
  const utf16 = path.join(dir, 'utf16.json');
  const bom8 = path.join(dir, 'bom8.json');
  writeFileSync(utf8, text);
  writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  writeFileSync(bom8, '﻿' + text);
  const expected = render(loadDoc(utf8, OWN), L(regressDoc()), { env: NO_GITHUB });
  assert.equal(render(loadDoc(utf16, OWN), L(regressDoc()), { env: NO_GITHUB }), expected);
  assert.equal(render(loadDoc(bom8, OWN), L(regressDoc()), { env: NO_GITHUB }), expected);
});

test('the protected block reads regress, or the tier when regress has none, with the count from the same document', () => {
  const tier = withProtected(TIER, [entry('flows/create-note.yaml'), entry('flows/sign-in.yaml')]);
  const regress = withProtected(REGRESS, [entry('tests/r01.json', { kind: 'tests' })], 'Protected files changed since origin/main (aaaaaaa):');
  const both = render(L(tier), L(regress), { env: NO_GITHUB });
  assert.equal(line1(both), 'rough-patch quick | no findings | 1 protected file change | non-blocking');
  assert.match(
    both,
    /^rough-patch quick[^\n]*\n\n<details><summary>Protected files: 1 change, used as written<\/summary>\n\n```text\nProtected files changed since origin\/main \(aaaaaaa\):\n {2}tests\/r01\.json: steps changed -> applied\n```\n<\/details>\n\n```text\n/,
  );
  assert.equal(both.includes('flows/create-note.yaml'), false);
  // The fences leave out their own protected section.
  assert.equal(both.includes('used as written (report.txt)'), false);

  for (const empty of [[], null]) {
    const r = regressDoc({ protectedLines: empty, protected: [] });
    const body = render(L(tier), L(r), { env: NO_GITHUB });
    assert.equal(line1(body), 'rough-patch quick | no findings | 2 protected file changes | non-blocking');
    assert.match(body, /<details><summary>Protected files: 2 changes, used as written<\/summary>\n\n```text\nProtected files changed since origin\/main \(3f2a91c\):\n {2}flows\/create-note\.yaml: steps changed -> applied\n {2}flows\/sign-in\.yaml: steps changed -> applied\n```\n<\/details>\n/);
  }
  const none = render(L(tierDoc()), L(regressDoc()), { env: NO_GITHUB });
  assert.equal(none.includes('<details'), false);
});

test("regress's protectedLines without a protected list still give the count from regress", () => {
  // regress with no tests writes protectedLines but no protected[] (regress.mts's early return).
  const tier = withProtected(TIER, [entry('flows/a.yaml'), entry('flows/b.yaml'), entry('flows/c.yaml')]);
  const regress = regressDoc({ protectedLines: ['Protected files changed since origin/main (3f2a91c):', '  flows/a.yaml: steps changed -> applied'] });
  delete regress.protected;
  const body = render(L(tier), L(regress), { env: NO_GITHUB });
  assert.equal(line1(body), 'rough-patch quick | no findings | 1 protected file change | non-blocking');
  assert.match(body, /<summary>Protected files: 1 change<\/summary>/);
});

test('the block opens for a weakening, held-back or CI entry', () => {
  const open = [
    entry('flows/create-note.yaml', { weakening: true, change: 'deleted' }),
    entry('flows/create-note.yaml', { used: 'reviewed' }),
    entry('tests/r01.json', { kind: 'tests', notApplied: ['checks removed'] }),
    entry('.github/workflows/rough-patch.yml', { kind: 'ci' }),
  ];
  for (const e of open) {
    const body = render(L(withProtected(TIER, [e])), L(regressDoc()), { env: NO_GITHUB });
    assert.match(body, /\n<details open><summary>Protected files: 1 change(, used as written)?<\/summary>\n/, JSON.stringify(e));
  }
  const deleted = render(L(withProtected(TIER, [entry('tests/r01.json', { kind: 'tests', weakening: true, change: 'deleted', used: 'saved-copy' })])), L(regressDoc()), { env: NO_GITHUB });
  assert.match(deleted, /\n<details open><summary>Protected files: 1 change<\/summary>\n/);
});

test('more than 100 protected entries show 100 then +N more changes (report.txt)', () => {
  const entries = Array.from({ length: 130 }, (_, i) => entry(`flows/f${String(i).padStart(3, '0')}.yaml`));
  const body = render(L(withProtected(TIER, entries)), L(regressDoc()), { env: NO_GITHUB });
  assert.equal(line1(body), 'rough-patch quick | no findings | 130 protected file changes | non-blocking');
  assert.match(body, /<summary>Protected files: 130 changes, used as written<\/summary>/);
  assert.equal(body.includes('flows/f099.yaml'), true);
  assert.equal(body.includes('flows/f100.yaml'), false);
  assert.match(body, /\n {2}flows\/f099\.yaml: steps changed -> applied\n {2}\+30 more changes \(report\.txt\)\n```\n<\/details>\n/);
});

test('a body over 60,000 bytes keeps only the first 20 protected entries', () => {
  const long = 'x'.repeat(600);
  const entries = Array.from({ length: 100 }, (_, i) => entry(`flows/${long}-${String(i).padStart(3, '0')}.yaml`));
  const body = render(L(withProtected(TIER, entries)), L(regressDoc()), { env: NO_GITHUB });
  assert.ok(Buffer.byteLength(body) <= 60_000, String(Buffer.byteLength(body)));
  assert.equal(body.includes(`${long}-019.yaml`), true);
  assert.equal(body.includes(`${long}-020.yaml`), false);
  assert.match(body, /\n {2}\+80 more changes \(report\.txt\)\n/);
  // Under the limit, all 100 stay.
  const small = render(L(withProtected(TIER, entries.slice(0, 50))), L(regressDoc()), { env: NO_GITHUB });
  assert.equal(small.includes(`${long}-049.yaml`), true);
});

test('each fence is one backtick longer than the longest run inside, and at least 3', () => {
  const tier = tierDoc({ sections: [...TIER.sections.slice(0, 2), { id: 'findings', lines: ['MED   Typed values lost on label "`````code`````"'] }, ...TIER.sections.slice(2)] });
  const body = render(L(tier), L(regressDoc()), { env: NO_GITHUB });
  assert.match(body, /\n``````text\n/);
  assert.match(body, /\n``````\n<!--/);
  assert.match(render(L(tierDoc()), L(regressDoc()), { env: NO_GITHUB }), /\n```text\n/);
  const protectedTicks = withProtected(TIER, [entry('flows/a``b.yaml')]);
  assert.match(render(L(protectedTicks), L(regressDoc()), { env: NO_GITHUB }), /<\/summary>\n\n```text\n/);
  const fourTicks = withProtected(TIER, [entry('flows/a````b.yaml')]);
  assert.match(render(L(fourTicks), L(regressDoc()), { env: NO_GITHUB }), /<\/summary>\n\n`````text\n/);
});

test('paths: under root become repo-relative, the root note is left out, .env is named once, and a cwd outside root prints as its basename', () => {
  const frontend = tierDoc({
    root: '/work/repo',
    cwd: '/work/repo/frontend',
    notes: [{ id: 'root', text: 'root: /work/repo' }, ...TIER.notes],
    sections: [TIER.sections[0], { id: 'notes', lines: ['root: /work/repo', ...TIER.sections[1].lines] }, ...TIER.sections.slice(2)],
  });
  const body = render(L(frontend), L(regressDoc()), { env: NO_GITHUB });
  assert.equal(body.includes('root:'), false);
  assert.equal(body.includes('/work/repo'), false);
  assert.match(body, /\nFull report: \.rough-patch\/runs\/20261027-184640-quick-hkhw\/report\.txt\n/);

  for (const who of ['flow sign-in', 'target.headers', 'reset']) {
    const lines = [`${who} uses E2E_PASSWORD, which isn't set. Set it in the environment, or set it in .rough-patch/.env (/work/repo/.rough-patch/.env).`];
    const stopped = stopDoc(TIER, { code: 'missing-variable', lines, runId: null, header: 'rough-patch quick | 0.1s | stopped' });
    const b = render(L(stopped), L(regressDoc()), { env: NO_GITHUB });
    assert.equal(line1(b), 'rough-patch quick | stopped (missing-variable) | non-blocking');
    assert.equal(b.split('.rough-patch/.env').length - 1, 1, b);
    assert.match(b, new RegExp(`\n${who.replace('.', '\\.')} uses E2E_PASSWORD, which isn't set\\. Set it in the environment, or set it in \\.rough-patch/\\.env\\.\n`));
  }

  const outside = stopDoc(TIER, { code: 'git-failed', lines: ['git rev-parse failed in /tmp/build/checkout: fatal: not a git repository (or any of the parent directories): .git'], runId: null, header: 'rough-patch quick | 0.0s | stopped' });
  outside.root = null;
  outside.cwd = '/tmp/build/checkout';
  const g = render(L(outside), L(regressDoc()), { env: NO_GITHUB });
  assert.match(g, /\ngit rev-parse failed in checkout: fatal: not a git repository/);
  assert.equal(g.includes('/tmp/build'), false);

  const elsewhere = tierDoc({ cwd: '/srv/other/place', sections: [...TIER.sections, { id: 'stop', lines: ['seen in /srv/other/place and /srv/other/place/x'] }] });
  assert.match(render(L(elsewhere), L(regressDoc()), { env: NO_GITHUB }), /\nseen in place and place\/x\n/);
});

test('a non-ASCII file name prints byte for byte inside a fence, and the words around it are ASCII', () => {
  const tier = withProtected(TIER, [entry('flows/crème-brûlée.yaml')]);
  const body = render(L(tier), L(regressDoc()), { env: NO_GITHUB });
  assert.equal(body.includes('  flows/crème-brûlée.yaml: steps changed -> applied'), true);
  const outside = body.split('\n').filter((_, i, all) => !insideFence(all, i));
  assert.ok(outside.every((l) => /^[\x00-\x7f]*$/.test(l)), outside.join('\n'));
});

// True when line i of a body sits between an opening and closing fence.
function insideFence(lines, i) {
  let open = null;
  for (let j = 0; j < i; j++) {
    const m = /^(`{3,})(text)?$/.exec(lines[j]);
    if (!m) continue;
    if (open === null) open = m[1];
    else if (m[1] === open && !m[2]) open = null;
  }
  return open !== null;
}

test('the links line appears only under GitHub Actions, with Run output only for an artifact URL in this repository', () => {
  const gh = { ...NO_GITHUB, GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'OWNER/REPO', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
  const tail = (body) => body.split('\n').slice(-3, -1);
  assert.deepEqual(tail(render(L(tierDoc()), L(regressDoc()), { env: gh, artifactUrl: 'https://github.com/OWNER/REPO/actions/runs/123/artifacts/456' })), [
    '[Run output](https://github.com/OWNER/REPO/actions/runs/123/artifacts/456) (kept 14 days) | [Job log](https://github.com/OWNER/REPO/actions/runs/123/attempts/2)',
    MARKER,
  ]);
  for (const url of ['https://evil.example/OWNER/REPO/x', 'https://github.com/OWNER/REPO-fork/actions/runs/1/artifacts/2', 'https://github.com/OWNER/REPO', '', null]) {
    const body = render(L(tierDoc()), L(regressDoc()), { env: gh, artifactUrl: url });
    assert.deepEqual(tail(body), ['[Job log](https://github.com/OWNER/REPO/actions/runs/123/attempts/2)', MARKER], String(url));
    assert.equal(body.includes('[Run output]'), false);
  }
  const local = render(L(tierDoc()), L(regressDoc()), { env: { ...gh, GITHUB_ACTIONS: '' }, artifactUrl: 'https://github.com/OWNER/REPO/actions/runs/123/artifacts/456' });
  assert.equal(local.includes('[Job log]'), false);
  assert.equal(local.includes('[Run output]'), false);
  assert.match(local, /\n```\n<!-- rough-patch:pr-comment -->\n$/);
});

test('the commit comes from pull_request.head.sha in the event file, else GITHUB_SHA, else is left out', () => {
  const dir = scratchDir();
  const event = path.join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: 'abcdef0123456789abcdef0123456789abcdef01' } } }));
  const pushEvent = path.join(dir, 'push.json');
  writeFileSync(pushEvent, JSON.stringify({ after: '1111111' }));
  const sha = '9c1e0aa5d2f0c0ffee00000000000000000000aa';
  const v = (env) => line1(render(L(tierDoc()), L(regressDoc()), { env: { ...NO_GITHUB, ...env } }));
  assert.equal(v({ GITHUB_EVENT_PATH: event, GITHUB_SHA: sha }), 'rough-patch quick | no findings | commit abcdef0 | non-blocking');
  assert.equal(v({ GITHUB_EVENT_PATH: pushEvent, GITHUB_SHA: sha }), 'rough-patch quick | no findings | commit 9c1e0aa | non-blocking');
  assert.equal(v({ GITHUB_SHA: sha }), 'rough-patch quick | no findings | commit 9c1e0aa | non-blocking');
  assert.equal(v({ GITHUB_EVENT_PATH: event }), 'rough-patch quick | no findings | commit abcdef0 | non-blocking');
  assert.equal(v({}), 'rough-patch quick | no findings | non-blocking');
  assert.equal(v({ GITHUB_EVENT_PATH: path.join(dir, 'missing.json') }), 'rough-patch quick | no findings | non-blocking');
});

// The CLI, through the built entry point.
function saved(tier = tierDoc(), regress = regressDoc()) {
  const dir = scratchDir();
  writeFileSync(path.join(dir, 'tier.json'), JSON.stringify(tier, null, 2));
  writeFileSync(path.join(dir, 'regress.json'), JSON.stringify(regress, null, 2));
  return { dir, tier: path.join(dir, 'tier.json'), regress: path.join(dir, 'regress.json') };
}

test('pr-comment exits 64 on an unknown flag, a tier other than quick or standard, or a wrong argument count', () => {
  const { tier, regress } = saved();
  for (const args of [
    ['pr-comment', 'quick', tier, regress, '--verbose'],
    ['pr-comment', 'quick', tier, regress, '--only', 'x'],
    ['pr-comment', 'deep', tier, regress],
    ['pr-comment', 'regress', tier, regress],
    ['pr-comment', 'quick', tier],
    ['pr-comment', 'quick', tier, regress, regress],
    ['pr-comment'],
  ]) {
    const r = run(args, { env: NO_GITHUB });
    assert.equal(r.code, 64, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    assert.equal(r.stdout.includes(MARKER), false);
  }
});

test('pr-comment prints the body and exits 0; --json prints exactly command, status, exitCode and body', () => {
  const { tier, regress } = saved();
  const expected = render(L(tierDoc()), L(regressDoc()), { env: NO_GITHUB });
  const r = run(['pr-comment', 'quick', tier, regress], { env: NO_GITHUB });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, expected);
  const j = run(['pr-comment', 'quick', tier, regress, '--json'], { env: NO_GITHUB });
  assert.equal(j.code, 0, j.stderr);
  const parsed = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['body', 'command', 'exitCode', 'status']);
  assert.deepEqual(parsed, { body: expected, command: 'pr-comment', exitCode: 0, status: 'passed' });
  const missing = run(['pr-comment', 'standard', path.join(scratchDir(), 'nope.json'), regress], { env: NO_GITHUB });
  assert.equal(missing.code, 0, missing.stderr);
  assert.equal(line1(missing.stdout), 'rough-patch standard | no summary | non-blocking');
});

test('pr-comment --artifact-url in GitHub Actions adds the links line from the environment', () => {
  const { tier, regress } = saved();
  const env = { ...NO_GITHUB, GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'OWNER/REPO', GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567' };
  const r = run(['pr-comment', 'quick', tier, regress, '--artifact-url', 'https://github.com/OWNER/REPO/actions/runs/7/artifacts/9'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(line1(r.stdout), 'rough-patch quick | no findings | commit 0123456 | non-blocking');
  assert.ok(r.stdout.endsWith('[Run output](https://github.com/OWNER/REPO/actions/runs/7/artifacts/9) (kept 14 days) | [Job log](https://github.com/OWNER/REPO/actions/runs/7/attempts/1)\n' + MARKER + '\n'));
  const outside = run(['pr-comment', 'quick', tier, regress, '--artifact-url=https://example.com/x'], { env });
  assert.equal(outside.code, 0, outside.stderr);
  assert.equal(outside.stdout.includes('[Run output]'), false);
});

test('run in a scratch folder with no git repository, pr-comment prints the same body and creates no file', () => {
  const { dir, tier, regress } = saved();
  const before = readdirSync(dir).sort();
  const here = run(['pr-comment', 'quick', tier, regress], { cwd: dir, env: NO_GITHUB });
  const empty = scratchDir();
  const elsewhere = run(['pr-comment', 'quick', tier, regress], { cwd: empty, env: NO_GITHUB });
  assert.equal(here.code, 0, here.stderr);
  assert.equal(elsewhere.stdout, here.stdout);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.deepEqual(readdirSync(empty), []);
  assert.equal(existsSync(path.join(empty, '.rough-patch')), false);
});

test('every body starts with rough-patch <tier> |, ends with the marker, stays under 60,000 bytes and names no absolute path', () => {
  assert.ok(bodies.length > 40, String(bodies.length));
  for (const body of bodies) {
    assert.match(body, /^rough-patch (quick|standard) \| /);
    assert.ok(body.endsWith(`\n${MARKER}\n`));
    assert.ok(Buffer.byteLength(body) <= 60_000);
    assert.equal(body.includes('Resilience contract: not in'), false);
    assert.equal(body.includes('/home/'), false);
    assert.equal(body.includes('/Users/'), false);
    assert.equal(body.includes('/work/repo'), false);
    assert.doesNotMatch(body, /(^|[\s(`'"])[A-Za-z]:[\\/]/m);
    assert.equal(body.includes('\r'), false);
  }
});

test('Windows paths: a cwd outside root prints its last component; paths under a backslash root print repo-relative once', async () => {
  const { rewritePaths } = await import('../dist/prcomment.mjs');
  assert.equal(rewritePaths('git rev-parse failed in C:\\work\\other: not a git repository', { root: null, cwd: 'C:\\work\\other' }), 'git rev-parse failed in other: not a git repository');
  assert.equal(
    rewritePaths('Set it in .rough-patch/.env (C:\\work\\proj\\.rough-patch\\.env).', { root: 'C:/work/proj', cwd: 'C:\\work\\proj\\app' }),
    'Set it in .rough-patch/.env.',
  );
  assert.equal(rewritePaths('Full report: C:/work/proj/.rough-patch/runs/x/report.txt', { root: 'C:\\work\\proj', cwd: 'C:\\work\\proj' }), 'Full report: .rough-patch/runs/x/report.txt');
});

test('hint lines stay with their entry and never count as changes', async () => {
  const { renderComment } = await import('../dist/prcomment.mjs');
  const lines = ['Protected files changed since origin/main (3f2a91c):'];
  for (let i = 0; i < 101; i++) lines.push(`  flows/f${String(i).padStart(3, '0')}.yaml: deleted after rough-patch wrote it (run r) -> ran the saved copy`, '    To remove it for good: delete it and commit.');
  const doc = { status: 'passed', root: '/work/repo', cwd: '/work/repo', protectedLines: lines, sections: [{ id: 'header', lines: ['rough-patch quick | 1s'] }], runner: {} };
  const body = renderComment({ tier: 'quick', tierDoc: { kind: 'doc', doc }, regressDoc: { kind: 'none' }, own: '0.1.0', env: {}, artifactUrl: null });
  assert.match(body, /\| 101 protected file changes \|/);
  assert.match(body, /Protected files: 101 changes<\/summary>/);
  assert.ok(body.includes('  flows/f099.yaml: deleted after rough-patch wrote it (run r) -> ran the saved copy\n    To remove it for good: delete it and commit.\n  +1 more changes (report.txt)'));
});

test('an artifact URL with a space, bracket or newline gets no Run output link', async () => {
  const { linksLine } = await import('../dist/prcomment.mjs');
  const env = { GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' };
  assert.match(linksLine(env, 'https://github.com/o/r/actions/runs/1/artifacts/2'), /^\[Run output\]/);
  for (const bad of ['https://github.com/o/r/x) [evil](https://e.com', 'https://github.com/o/r/x\n<!-- rough-patch:pr-comment -->', 'https://github.com/o/r/a b']) {
    assert.equal(linksLine(env, bad), '[Job log](https://github.com/o/r/actions/runs/1/attempts/1)');
  }
});
