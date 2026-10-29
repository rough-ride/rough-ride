import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { contractProblems, normalise, readmeBlock, readTree, sha256 } from '../../../scripts/contract-sync.mjs';
import { npmPack } from '../../../scripts/pack-contents.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const tree = await readTree(ROOT);
const text = tree.template.toString('utf8');

// The tree with its template text replaced, the README and editions kept in step.
function withText(next, over = {}) {
  const template = Buffer.from(next);
  const readme = tree.readme.replace(text, next);
  const editions = tree.editions.map((e, i, all) => (i === all.length - 1 ? { ...e, sha256: sha256(normalise(template)) } : e));
  return { ...tree, template, readme, editions, ...over };
}
const has = (problems, re) => assert.ok(problems.some((p) => re.test(p)), problems.join('\n') || 'no problems');

test('the release tree passes, and the coverage map covers every id with no double-click entry', () => {
  assert.deepEqual(contractProblems(tree), []);
  assert.equal(readmeBlock(tree.readme), text);
  assert.equal(tree.ids.checks.length, 10);
  assert.equal(tree.ids.faults.length, 9);
  assert.deepEqual(tree.ids.attacks.sort(), ['back', 'double-submit', 'out-of-order', 'refresh', 'signed-out-reload', 'viewport-375']);
  assert.equal(Object.keys(tree.coverage).length, 10 + 9 + tree.ids.inputs.length + 6);
  assert.ok(!('double-click' in tree.coverage));
  assert.equal(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), tree.readme);
});

test('(a) one byte of the README block differs from the template', () => {
  has(contractProblems({ ...tree, readme: tree.readme.replace('375 px wide screen', '375 px wide screen ') }), /^\(a\) the README block differs/);
  has(contractProblems({ ...tree, readme: tree.readme.replace('## Resilience contract\n\nThe', '## Resilience\n\nThe') }), /^\(a\) the README has no fenced markdown block/);
});

test('(b) the template changes without a new editions entry; editions skip; a frozen entry changes', () => {
  const changed = Buffer.from(text.replace('stays disabled', 'stays greyed out'));
  has(contractProblems({ ...tree, template: changed, readme: tree.readme.replace(text, changed.toString()) }), /^\(b\) the template's sha256 .* needs a new editions entry/);
  has(contractProblems({ ...tree, editions: [{ ...tree.editions[0], edition: 2 }] }), /^\(b\) contract-editions.json entry 1 has edition 2/);
  has(contractProblems({ ...tree, editions: [tree.editions[0], { ...tree.editions[0], edition: 2 }] }), /same sha256/);
  const frozen = [{ ...tree.editions[0], since: '0.4.0' }];
  assert.deepEqual(contractProblems({ ...tree, editions: frozen, previous: frozen }), []);
  has(contractProblems({ ...tree, editions: [{ ...frozen[0], summary: 'reworded' }], previous: frozen }), /^\(b\) edition 1 is frozen \(since 0.4.0\) and changed/);
  // A real new edition passes: marker, entry and hash move together.
  const next = text.replace('edition=1', 'edition=2').replace('stays disabled', 'stays greyed out');
  const tpl = Buffer.from(next);
  assert.deepEqual(contractProblems({ ...withText(next), editions: [...tree.editions, { edition: 2, sha256: sha256(tpl), since: null, summary: 'clearer item 2' }] }), []);
  has(contractProblems(withText(next)), /marker says edition 2; the last editions entry is 1/);
});

test('(c) S or the viewport in the tier table changes without the text', () => {
  has(contractProblems({ ...tree, tier: { ...tree.tier, S: 12_000 } }), /^\(c\) the text says 10 seconds; S in the tier table is 12 s/);
  has(contractProblems({ ...tree, tier: { ...tree.tier, viewport: 360 } }), /^\(c\) the text says 375 px/);
});

test('(d) a new exported id has no coverage entry; an unknown id or item; a numbered item maps to nothing', () => {
  has(contractProblems({ ...tree, ids: { ...tree.ids, attacks: [...tree.ids.attacks, 'offline'] } }), /^\(d\) offline has no coverage entry/);
  has(contractProblems({ ...tree, coverage: { ...tree.coverage, 'double-click': [5] } }), /^\(d\) the coverage map names double-click/);
  has(contractProblems({ ...tree, coverage: { ...tree.coverage, settles: [12] } }), /^\(d\) settles maps to 12/);
  const no4 = Object.fromEntries(Object.entries(tree.coverage).map(([id, parts]) => [id, parts.filter((p) => p !== 4)]));
  has(contractProblems({ ...tree, coverage: no4 }), /^\(d\) item 4 maps to nothing/);
});

test('(e) and (f): a backtick, a word starting with @, a stray digit, the word settles, the string rough-ride', () => {
  const item1 = 'say so on the page, not only in the console.';
  has(contractProblems(withText(text.replace(item1, 'say so on the page, not only in the `console`.'))), /^\(f\) the text has a backtick/);
  has(contractProblems(withText(text.replace(item1, 'say so on the page; see @docs/errors.md.'))), /^\(f\) a word starts with @/);
  has(contractProblems(withText(text.replace(item1, 'say so on the page within 2 s.'))), /^\(f\) the text has a digit outside the item numbers/);
  has(contractProblems(withText(text.replace('Nothing spins forever', 'Every page settles; nothing spins forever'))), /^\(f\) the text uses the word settles/);
  has(contractProblems(withText(text.replace('the app behaves the same', 'rough-ride sees the app behave the same'))), /^\(e\) the text names roughride/);
  has(contractProblems(withText(text.replace('the app behaves the same', 'the app behaves the same (out-of-order too)'))), /^\(f\) the text uses the word out-of-order/);
  has(contractProblems(withText(text.replace('the console.', 'the console.\t'))), /^\(e\) the text has a byte outside printable ASCII/);
  has(contractProblems(withText(text.replace('\n\nThis is for', '\nAnother line.\n\nThis is for'))), /^\(e\) the text has 17 non-blank lines/);
});

test('the packed tarball holds the template, its MIT-0 LICENSE and the editions file; CONTRIBUTING.md states the MIT-0 rule', () => {
  const files = npmPack(fileURLToPath(new URL('..', import.meta.url))).files.map((f) => f.path);
  for (const f of ['templates/resilience-contract.md', 'templates/LICENSE', 'dist/contract-editions.json']) assert.ok(files.includes(f), f);
  assert.match(readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8'), /templates\/` are made under that folder's MIT-0 licence/);
});
