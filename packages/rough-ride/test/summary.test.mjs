import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCK_END, BLOCK_START, membersText, renderSummary, reproId, SUMMARY_BYTES, SUMMARY_LINES } from '../dist/summary.mjs';

const many = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));

function worstCase(width = 60) {
  const pad = (s) => (s + ' ' + 'x'.repeat(width)).slice(0, Math.max(s.length, width));
  return {
    header: ['rough-ride quick | 1m38s | run 20261025-141207-quick-k3fz', 'diff: origin/main 3f2a91c..working tree | 40 files', 'target: http://localhost:3731 (proven Nuxt dev server)'],
    nothingAttacked: null,
    notes: many(7, (i) => ({ id: i === 1 ? 'root' : 'tracing', text: pad(`note ${i}`) })),
    protectedBlock: ['Protected files changed since origin/main (3f2a91c):', ...many(6, (i) => pad(`  flows/f${i}.yaml: changed -> ran the origin/main version`))],
    flowLines: many(5, (i) => pad(`Baseline failed: f${i} at step 2 (click button "Go"): not visible after 10 s. Not attacked until it passes.`)),
    findings: many(7, (i) => [pad(`HIGH  No message when POST /api/x${i} fails with 500 (button "Save") | repro r0${i}`), pad(`      /x${i} | 500! on POST /api/x${i} #1 | fails: visible-error-message`)]),
    afterFindings: ['Not shown: 2 more finding groups (report.txt)'],
    attacksLine: 'Attacks: 3 of 40 changed files attacked | 9 attacks: 2 passed, 7 failed',
    notAttacked: many(9, (i) => pad(`Not attacked: app/file${i}.ts (no flow reaches it)`)),
    scopeLine: 'Requests your servers send are never attacked in v1.',
    contract: null,
    commands: ['Investigate (keeps running; start it in the background): npx --no rough-ride repro 20261025-141207-quick-k3fz/r01 --keep-open'],
    fullReport: 'Full report: /Users/me/app/.rough-ride/runs/20261025-141207-quick-k3fz/report.txt',
    runner: ['Runner: rough-ride 0.1.0 from npx | Node 22.22.1 | Playwright 1.64.1'],
  };
}

test('every section over its cap ends with one overflow line inside it; at most 40 lines', () => {
  const lines = renderSummary(worstCase());
  assert.ok(lines.length <= SUMMARY_LINES);
  assert.ok(lines.includes('+5 more notes (report.txt)'), 'notes: 2 lines and the overflow');
  assert.ok(lines.includes('  +4 more changes (report.txt)'), 'protected: heading, 2 entries and the overflow');
  assert.ok(lines.includes('+3 more flow lines (report.txt)'));
  assert.equal(lines.filter((l) => /^HIGH/.test(l)).length, 5, 'at most 5 shown groups');
  assert.ok(lines.includes('+6 more not attacked (report.txt)'));
  const i = lines.indexOf('Attacks: 3 of 40 changed files attacked | 9 attacks: 2 passed, 7 failed');
  assert.deepEqual(lines.slice(i, i + 6).map((l) => l.slice(0, 20)), ['Attacks: 3 of 40 cha', 'Not attacked: app/fi', 'Not attacked: app/fi', 'Not attacked: app/fi', '+6 more not attacked', 'Requests your server']);
  assert.ok(lines.every((l) => /^[\x20-\x7e]*$/.test(l)), 'plain ASCII, no ANSI, no \\r');
});

test('the byte cap drops Not attacked lines first, then notes, then protected entries', () => {
  const view = worstCase(236);
  // Commands print whole, so long ones push the summary past 8,000 bytes.
  view.commands = many(3, (i) => `Investigate ${i}: ${'c'.repeat(1100)}`);
  const lines = renderSummary(view);
  assert.ok(Buffer.byteLength(lines.join('\n') + '\n') <= SUMMARY_BYTES, `${Buffer.byteLength(lines.join('\n'))} bytes`);
  const na = lines.filter((l) => l.startsWith('Not attacked:')).length;
  const notes = lines.filter((l) => l.startsWith('note ')).length;
  assert.ok(na < 3, 'Not attacked lines went first');
  assert.ok(lines.some((l) => /^\+\d+ more not attacked \(report\.txt\)$/.test(l)));
  if (na > 0) assert.equal(notes, 2, 'notes keep their lines while Not attacked lines remain');
});

test('lines over 240 characters are cut with ...; commands and the Full report path print whole', () => {
  const view = worstCase();
  view.notes = [{ id: 'tracing', text: 'n'.repeat(300) }];
  view.commands = [`Investigate (keeps running; start it in the background): ${'c'.repeat(300)}`];
  const lines = renderSummary(view);
  const note = lines.find((l) => l.startsWith('nnn'));
  assert.equal(note.length, 240);
  assert.ok(note.endsWith('...'));
  assert.ok(lines.some((l) => l.startsWith('Investigate') && l.length > 300));
});

test('with a plugin data folder the summary sits between the two marker lines, which count toward the bytes only', () => {
  const lines = renderSummary(worstCase(236), true);
  assert.equal(lines[0], BLOCK_START);
  assert.equal(lines.at(-1), BLOCK_END);
  assert.ok(lines.length - 2 <= SUMMARY_LINES);
  assert.ok(Buffer.byteLength(lines.join('\n') + '\n') <= SUMMARY_BYTES);
});

test('a golden summary: the sample app\'s cleared-form shape renders byte for byte', () => {
  const lines = renderSummary({
    header: ['rough-ride quick | 1m38s | run 20261025-141207-quick-k3fz | 0.x pre-release: detection and false-alarm rates not measured yet', 'diff: origin/main 3f2a91c..working tree | 1 file -> 1 flow, 1 form', 'target: http://localhost:3731 (proven Nuxt dev server) | API http://localhost:8731 | Chrome 155.0.8059.81'],
    nothingAttacked: null,
    notes: [],
    protectedBlock: [],
    flowLines: [],
    findings: [['MED   Typed values lost after POST /api/notes fails with 500 (button "Save") | 2 attacks | repro r01', '      /notes/new | 500!, reset! on POST /api/notes #1 | fails: values-survive, retry-recovers']],
    afterFindings: [],
    attacksLine: 'Attacks: 1 of 1 changed file attacked | 6 attacks: 4 passed, 2 failed',
    notAttacked: [],
    scopeLine: null,
    contract: null,
    commands: ['Investigate (keeps running; start it in the background): npx --no rough-ride repro 20261025-141207-quick-k3fz/r01 --keep-open'],
    fullReport: 'Full report: /Users/me/app/.rough-ride/runs/20261025-141207-quick-k3fz/report.txt',
    runner: ['Runner: rough-ride 0.1.0 from npx | Node 22.22.1 | Playwright 1.64.1'],
  });
  assert.equal(lines.join('\n') + '\n', `rough-ride quick | 1m38s | run 20261025-141207-quick-k3fz | 0.x pre-release: detection and false-alarm rates not measured yet
diff: origin/main 3f2a91c..working tree | 1 file -> 1 flow, 1 form
target: http://localhost:3731 (proven Nuxt dev server) | API http://localhost:8731 | Chrome 155.0.8059.81
MED   Typed values lost after POST /api/notes fails with 500 (button "Save") | 2 attacks | repro r01
      /notes/new | 500!, reset! on POST /api/notes #1 | fails: values-survive, retry-recovers
Attacks: 1 of 1 changed file attacked | 6 attacks: 4 passed, 2 failed
Investigate (keeps running; start it in the background): npx --no rough-ride repro 20261025-141207-quick-k3fz/r01 --keep-open
Full report: /Users/me/app/.rough-ride/runs/20261025-141207-quick-k3fz/report.txt
Runner: rough-ride 0.1.0 from npx | Node 22.22.1 | Playwright 1.64.1
`);
});

test('members compress by request, keep ! for sticky faults, and cut at 80; repro ids have at least two digits', () => {
  assert.equal(membersText([
    { kind: 'fault', fault: '500', sticky: true, key: 'POST /api/login #1', id: 'a' },
    { kind: 'fault', fault: '400', sticky: true, key: 'POST /api/login #1', id: 'b' },
    { kind: 'fault', fault: '500', sticky: false, key: 'GET /api/me #1', id: 'c' },
    { kind: 'timing', fault: null, sticky: false, key: 'POST /api/notes #1', id: 'create-note/POST /api/notes #1/double-submit' },
  ]), '500!, 400! on POST /api/login #1; 500 on GET /api/me #1; double-submit on POS...');
  assert.equal(membersText(many(9, (i) => ({ kind: 'fault', fault: '500', sticky: true, key: `POST /api/very-long-endpoint-name-${i} #1`, id: `${i}` }))).length, 80);
  assert.deepEqual([3, 12, 123].map(reproId), ['r03', 'r12', 'r123']);
});
