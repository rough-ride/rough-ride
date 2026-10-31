import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_FILES, contractJson, contractLine, contractStatus, detectContract, editionSummary, firstMarker,
  importsFile, readInstruction, summaryContractLine, templateEdition, TEMPLATE_FILE,
} from '../dist/contract.mjs';
import { renderSections } from '../dist/summary.mjs';
import { startSite } from './fixtures/test-site.mjs';
import { gitRepo, runAsync, run, scratchDir, sh } from './helpers.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = readFileSync(path.join(PKG, 'templates', 'resilience-contract.md'), 'utf8');
const URL1 = 'https://github.com/rough-ride/rough-ride/blob/v0.1.0/README.md#resilience-contract';
const ALSO = ` (also at ${TEMPLATE_FILE.split(path.sep).join('/')})`;

function write(root, rel, text) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

const detect = (root, base = null, baseRef = null) => detectContract(root, base, baseRef);

test('the template: ASCII, LF, a final newline, 2,115 characters, 16 non-blank lines, edition 1, MIT-0 next to it', () => {
  const bytes = readFileSync(path.join(PKG, 'templates', 'resilience-contract.md'));
  assert.ok(/^[\n\x20-\x7e]*$/.test(bytes.toString('latin1')));
  assert.equal(bytes.length, 2115);
  assert.ok(TEMPLATE.endsWith(' -->\n') && !TEMPLATE.includes('\r'));
  assert.equal(TEMPLATE.split('\n').filter((l) => l.trim() !== '').length, 16);
  assert.equal(TEMPLATE.split('\n')[0], '<!-- resilience-contract edition=1 -->');
  assert.equal(templateEdition(), 1);
  assert.match(readFileSync(path.join(PKG, 'templates', 'LICENSE'), 'utf8'), /^MIT No Attribution/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(PKG, 'dist', 'contract-editions.json'), 'utf8')), JSON.parse(readFileSync(path.join(PKG, 'src', 'contract-editions.json'), 'utf8')));
  assert.equal(editionSummary(1), JSON.parse(readFileSync(path.join(PKG, 'src', 'contract-editions.json'), 'utf8'))[0].summary);
});

test('markers: trimmed lines match; edition=0 and edition=10000 are not markers; the declined line', () => {
  assert.deepEqual(firstMarker('x\n   <!-- resilience-contract edition=1 -->  \n'), { kind: 'edition', edition: 1 });
  assert.deepEqual(firstMarker('<!-- resilience-contract edition=9999 -->'), { kind: 'edition', edition: 9999 });
  assert.equal(firstMarker('<!-- resilience-contract edition=0 -->\n<!-- resilience-contract edition=10000 -->\n'), null);
  assert.equal(firstMarker('<!-- resilience-contract edition=01 -->'), null);
  assert.deepEqual(firstMarker(' <!-- resilience-contract declined -->\n<!-- resilience-contract edition=1 -->'), { kind: 'declined' });
});

test('@AGENTS.md counts as an import only as a whitespace-delimited token outside fenced code', () => {
  assert.equal(importsFile('# Notes\n@AGENTS.md\n', 'AGENTS.md'), true);
  assert.equal(importsFile('See @./AGENTS.md for more.', 'AGENTS.md'), true);
  assert.equal(importsFile('```\n@AGENTS.md\n```\n', 'AGENTS.md'), false);
  assert.equal(importsFile('~~~~md\n@AGENTS.md\n~~~~\n', 'AGENTS.md'), false);
  assert.equal(importsFile('```\nx\n```\n@AGENTS.md\n', 'AGENTS.md'), true);
  assert.equal(importsFile('`@AGENTS.md` and x@AGENTS.md', 'AGENTS.md'), false);
  assert.equal(importsFile('@AGENTS.md', '.claude/AGENTS.md'), false);
  assert.equal(importsFile('@.claude/AGENTS.md', '.claude/AGENTS.md'), true);
});

test('a root CLAUDE.md holding edition 1 is current, file CLAUDE.md, and prints no line', () => {
  const root = scratchDir();
  write(root, 'CLAUDE.md', `# Project\n\n${TEMPLATE}`);
  const c = detect(root);
  assert.deepEqual(contractJson(c), { status: 'current', file: 'CLAUDE.md', edition: 1, current: 1 });
  assert.equal(contractLine(c, { version: '0.1.0', ci: false }), null);
  write(root, 'CLAUDE.md', '\uFEFF' + TEMPLATE.replace(/\n/g, '\r\n'));
  assert.equal(detect(root).status, 'current', 'BOM and CRLF');
  write(root, '.claude/CLAUDE.md', TEMPLATE);
  rmSync(path.join(root, 'CLAUDE.md'));
  assert.deepEqual(contractJson(detect(root)), { status: 'current', file: '.claude/CLAUDE.md', edition: 1, current: 1 });
});

test('declined and newer print nothing; older names the runner edition and its summary', () => {
  const root = scratchDir();
  write(root, 'CLAUDE.md', '<!-- resilience-contract declined -->\n');
  write(root, 'AGENTS.md', TEMPLATE);
  const declined = detect(root);
  assert.deepEqual(contractJson(declined), { status: 'declined', file: 'CLAUDE.md', edition: null, current: 1 });
  assert.equal(contractLine(declined, { version: '0.1.0', ci: false }), null);
  write(root, 'CLAUDE.md', TEMPLATE.replace('edition=1', 'edition=2'));
  const newer = detect(root);
  assert.equal(newer.status, 'newer');
  assert.equal(contractLine(newer, { version: '0.1.0', ci: false }), null);

  write(root, 'CLAUDE.md', TEMPLATE);
  const now = new Map(CONTRACT_FILES.map((f) => [f, readInstruction(root, f)]));
  const older = contractStatus(now, null, null, 2);
  assert.deepEqual(contractJson(older), { status: 'older', file: 'CLAUDE.md', edition: 1, current: 2 });
  const editions = path.join(scratchDir(), 'contract-editions.json');
  writeFileSync(editions, JSON.stringify([{ edition: 1, summary: 'one' }, { edition: 2, summary: 'adds item 12 on offline pages' }]));
  assert.equal(contractLine(older, { version: '0.6.0', ci: true, summary: editionSummary(2, editions) }),
    'Resilience contract: CLAUDE.md has edition 1; rough-ride 0.6.0 ships edition 2 (adds item 12 on offline pages). The user replaces the section between its two marker lines with the text at https://github.com/rough-ride/rough-ride/blob/v0.6.0/README.md#resilience-contract; agents leave instruction files alone.');
});

test('not-loaded: the marker only in AGENTS.md under a CLAUDE.md without @AGENTS.md; the import outside fenced code makes it current', () => {
  const root = scratchDir();
  write(root, 'AGENTS.md', TEMPLATE);
  write(root, 'CLAUDE.md', '# Project\n\n```\n@AGENTS.md\n```\n');
  const c = detect(root);
  assert.deepEqual(contractJson(c), { status: 'not-loaded', file: 'AGENTS.md', edition: 1, current: 1 });
  assert.equal(contractLine(c, { version: '0.1.0', ci: true }),
    "Resilience contract: found in AGENTS.md, but Claude Code reads the root CLAUDE.md instead, which doesn't import AGENTS.md (unless Project instructions is set to claude-md-and-agents-md). The user moves the section into CLAUDE.md or adds the line @AGENTS.md to it; agents leave instruction files alone.");
  write(root, 'CLAUDE.md', '# Project\n\n@AGENTS.md\n');
  assert.equal(detect(root).status, 'current');
  // With no CLAUDE file Claude Code reads AGENTS.md itself.
  rmSync(path.join(root, 'CLAUDE.md'));
  assert.deepEqual(contractJson(detect(root)), { status: 'current', file: 'AGENTS.md', edition: 1, current: 1 });

  // Resolution 111: the line names the files found.
  const other = scratchDir();
  write(other, '.claude/AGENTS.md', TEMPLATE);
  write(other, 'CLAUDE.md', '# Project\n@AGENTS.md\n');
  assert.equal(contractLine(detect(other), { version: '0.1.0', ci: true }),
    "Resilience contract: found in .claude/AGENTS.md, but Claude Code reads the root CLAUDE.md instead, which doesn't import .claude/AGENTS.md (unless Project instructions is set to claude-md-and-agents-md). The user moves the section into CLAUDE.md or adds the line @.claude/AGENTS.md to it; agents leave instruction files alone.");
  rmSync(path.join(other, 'CLAUDE.md'));
  write(other, '.claude/CLAUDE.md', '# Project\n');
  assert.match(contractLine(detect(other), { version: '0.1.0', ci: true }), /reads \.claude\/CLAUDE\.md instead, .* moves the section into \.claude\/CLAUDE\.md or adds the line @\.claude\/AGENTS\.md to it;/);
});

test('missing: CLAUDE.local.md is never touched; a link outside the root, a file over 1 MiB and UTF-16 count as no marker', () => {
  const root = scratchDir();
  write(root, 'CLAUDE.local.md', TEMPLATE);
  const asked = [];
  const c = detectContract(root, null, null, (r, rel) => {
    asked.push(rel);
    return readInstruction(r, rel);
  });
  assert.deepEqual(asked, ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', '.claude/AGENTS.md']);
  assert.deepEqual(contractJson(c), { status: 'missing', file: null, edition: null, current: 1 });

  // File links need extra rights on Windows.
  if (process.platform !== 'win32') {
    const outside = path.join(scratchDir(), 'contract.md');
    writeFileSync(outside, TEMPLATE);
    symlinkSync(outside, path.join(root, 'CLAUDE.md'));
    assert.equal(detect(root).status, 'missing', 'a link outside the root');
    rmSync(path.join(root, 'CLAUDE.md'));
    const sibling = `${root}-sibling`;
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, 'contract.md'), TEMPLATE);
    symlinkSync(path.join(sibling, 'contract.md'), path.join(root, 'CLAUDE.md'));
    assert.equal(detect(root).status, 'missing', 'a link into a sibling whose name starts with the root\'s');
    rmSync(path.join(root, 'CLAUDE.md'));
    write(root, 'inside.md', TEMPLATE);
    symlinkSync(path.join(root, 'inside.md'), path.join(root, 'CLAUDE.md'));
    assert.equal(detect(root).status, 'current', 'a link inside the root');
    rmSync(path.join(root, 'CLAUDE.md'));
  }
  write(root, 'CLAUDE.md', TEMPLATE + 'x'.repeat(1024 * 1024));
  assert.equal(detect(root).status, 'missing', 'over 1 MiB');
  writeFileSync(path.join(root, 'CLAUDE.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEMPLATE, 'utf16le')]));
  assert.equal(detect(root).status, 'missing', 'UTF-16 with a BOM');
  writeFileSync(path.join(root, 'CLAUDE.md'), Buffer.from(TEMPLATE, 'utf16le'));
  assert.equal(detect(root).status, 'missing', 'UTF-16 without a BOM');
  mkdirSync(path.join(root, 'AGENTS.md'));
  assert.equal(detect(root).status, 'missing', 'a folder');
});

test('removed: a marker at the merge base and none now names the base ref and short sha', () => {
  const root = scratchDir();
  const base = new Map([['CLAUDE.md', null], ['.claude/CLAUDE.md', null], ['AGENTS.md', Buffer.from(TEMPLATE)], ['.claude/AGENTS.md', null]]);
  const c = detect(root, base, { shown: 'origin/main', mergeBase: '3f2a91c0123456789abcdef0123456789abcdef0' });
  assert.deepEqual(contractJson(c), { status: 'removed', file: 'AGENTS.md', edition: 1, current: 1 });
  assert.equal(contractLine(c, { version: '0.1.0', ci: true }),
    'Resilience contract: AGENTS.md had edition 1 at origin/main (3f2a91c); the working tree has none. The user decides whether it goes back; agents leave instruction files alone.');
  const declinedAtBase = new Map([['CLAUDE.md', Buffer.from('<!-- resilience-contract declined -->\n')]]);
  assert.equal(detect(root, declinedAtBase, { shown: 'main', mergeBase: 'abcdef1234' }).status, 'missing');
});

test('the missing line: the tag URL, (also at ...) with forward slashes outside CI only', () => {
  const c = { status: 'missing', file: null, edition: null, current: 1 };
  const text = (url) => `Resilience contract: not in the root CLAUDE.md, .claude/CLAUDE.md, AGENTS.md or .claude/AGENTS.md. Pasted into the root CLAUDE.md, it tells coding agents which failures to design for; it changes nothing rough-ride attacks or judges. Text: ${url}. The user decides; agents leave instruction files alone.`;
  assert.equal(contractLine(c, { version: '0.1.0', ci: true }), text(URL1));
  assert.equal(contractLine(c, { version: '0.1.0', ci: false }), text(URL1 + ALSO));
  assert.equal(contractLine(c, { version: '0.1.0', ci: false, templateFile: ['C:', 'rp', 'templates', 'resilience-contract.md'].join(path.sep) }), text(`${URL1} (also at C:/rp/templates/resilience-contract.md)`));
  assert.ok(!contractLine(c, { version: '0.1.0', ci: false }).includes('\\'));
});

test('summary placement: plan prints none; missing only beside a shown finding and never in CI; one line, never cut', () => {
  const missing = { status: 'missing', file: null, edition: null, current: 1 };
  const older = { status: 'older', file: 'CLAUDE.md', edition: 1, current: 2 };
  const line = contractLine(missing, { version: '0.1.0', ci: false });
  assert.ok(line.length > 240);
  assert.equal(summaryContractLine(missing, line, { plan: false, shownFindings: 0, ci: false }), null);
  assert.equal(summaryContractLine(missing, line, { plan: false, shownFindings: 1, ci: false }), line);
  assert.equal(summaryContractLine(missing, line, { plan: false, shownFindings: 1, ci: true }), null);
  assert.equal(summaryContractLine(older, 'x', { plan: false, shownFindings: 0, ci: true }), 'x');
  assert.equal(summaryContractLine(older, 'x', { plan: true, shownFindings: 3, ci: false }), null);
  assert.equal(summaryContractLine(null, null, { plan: false, shownFindings: 3, ci: false }), null);
  const view = { header: ['h'], nothingAttacked: null, notes: [], protectedBlock: [], flowLines: [], findings: [], afterFindings: [], attacksLine: null, notAttacked: [], scopeLine: null, contract: line, commands: [], fullReport: null, runner: ['Runner: x'] };
  assert.deepEqual(renderSections(view).find((s) => s.id === 'contract'), { id: 'contract', lines: [line] });
});

// ---- Through the CLI.

function repo() {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'app.js'), 'export {}\n');
  return root;
}
const commit = (root, msg = 'base') => {
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', msg);
};

test('a diff that only pastes the contract into CLAUDE.md reads Nothing to attack and detects nothing', () => {
  const root = repo();
  commit(root);
  writeFileSync(path.join(root, 'CLAUDE.md'), TEMPLATE);
  const { code, stdout } = run(['quick', '--json'], { cwd: root });
  assert.equal(code, 0);
  const doc = JSON.parse(stdout);
  assert.equal(doc.status, 'nothing-to-attack');
  assert.match(doc.summaryLines[1], /^Nothing to attack/);
  assert.equal(doc.contract, null);
});

test('a stop after the read-once step still records the status; removed is seen against the merge base', () => {
  const root = repo();
  writeFileSync(path.join(root, 'CLAUDE.md'), TEMPLATE);
  commit(root);
  sh(root, 'checkout', '-q', '-b', 'feature');
  rmSync(path.join(root, 'CLAUDE.md'));
  writeFileSync(path.join(root, 'app.js'), 'export const x = 1\n');
  const doc = JSON.parse(run(['quick', '--json'], { cwd: root }).stdout);
  assert.ok(doc.stop);
  assert.deepEqual(doc.contract, { status: 'removed', file: 'CLAUDE.md', edition: 1, current: 1 });
  writeFileSync(path.join(root, 'CLAUDE.md'), TEMPLATE);
  assert.deepEqual(JSON.parse(run(['quick', '--json'], { cwd: root }).stdout).contract, { status: 'current', file: 'CLAUDE.md', edition: 1, current: 1 });
});

test('regress, repro, flow save, snapshot and link carry contract null', () => {
  const root = repo();
  writeFileSync(path.join(root, 'CLAUDE.md'), TEMPLATE);
  commit(root);
  writeFileSync(path.join(root, 'app.js'), 'export const x = 1\n');
  for (const args of [['regress'], ['repro', '20261028-101010-quick-ab12/r01'], ['flow', 'save', 'x'], ['snapshot', '--run', '20261028-101010-plan-ab12'], ['link', '--run', '20261028-101010-plan-ab12']]) {
    const doc = JSON.parse(run([...args, '--json'], { cwd: root }).stdout);
    assert.equal(doc.contract, null, args.join(' '));
  }
});

let site;
before(async () => {
  site = await startSite();
});
after(() => site?.server.close());

const PASSING = 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - goto: /late\n  - expect: {text: Loaded later}\n';

function project() {
  const root = repo();
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), `schema: 0.1.0\ntarget:\n  url: ${site.url}\n`);
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'home.yaml'), PASSING);
  commit(root);
  writeFileSync(path.join(root, 'app.js'), 'export const changed = 1\n');
  return root;
}

const report = (root, id) => readFileSync(path.join(root, '.rough-ride', 'runs', id, 'report.txt'), 'utf8');
const record = (root, id) => JSON.parse(readFileSync(path.join(root, '.rough-ride', 'runs', id, 'record.json'), 'utf8'));

test('quick: missing prints no summary line without a finding, report.txt carries it; current prints none anywhere', async () => {
  const root = project();
  const env = { CI: undefined, GITHUB_ACTIONS: undefined };
  const doc = JSON.parse((await runAsync(['quick', '--json'], { cwd: root, env })).stdout);
  assert.equal(doc.status, 'nothing-attacked');
  assert.deepEqual(doc.contract, { status: 'missing', file: null, edition: null, current: 1 });
  assert.equal(record(root, doc.runId).contract.status, 'missing');
  assert.ok(!doc.summaryLines.some((l) => l.startsWith('Resilience contract')));
  const lines = report(root, doc.runId).split('\n');
  const at = lines.findIndex((l) => l.startsWith('Resilience contract: not in the root CLAUDE.md'));
  assert.ok(at > 0 && lines[at].includes(ALSO), report(root, doc.runId));
  assert.equal(lines[at + 2], 'Runner: ' + lines.find((l) => l.startsWith('Runner: ')).slice(8), 'section 12 comes right before the runner block when there are no commands');

  writeFileSync(path.join(root, 'CLAUDE.md'), TEMPLATE);
  const again = JSON.parse((await runAsync(['quick', '--json'], { cwd: root, env })).stdout);
  assert.deepEqual(again.contract, { status: 'current', file: 'CLAUDE.md', edition: 1, current: 1 });
  assert.ok(!report(root, again.runId).includes('Resilience contract'));
});

test('plan records the status and prints no line; attack reads no instruction file and carries the plan status everywhere', async () => {
  const root = project();
  write(root, 'AGENTS.md', TEMPLATE);
  write(root, 'CLAUDE.md', '# Project\n');
  const env = { CI: undefined, GITHUB_ACTIONS: undefined };
  const plan = JSON.parse((await runAsync(['plan', 'quick', '--json'], { cwd: root, env })).stdout);
  assert.equal(plan.status, 'planned', JSON.stringify(plan.stop));
  assert.deepEqual(plan.contract, { status: 'not-loaded', file: 'AGENTS.md', edition: 1, current: 1 });
  assert.ok(!plan.summaryLines.some((l) => l.startsWith('Resilience contract')));
  const notLoaded = report(root, plan.runId).split('\n').find((l) => l.startsWith('Resilience contract: found in AGENTS.md'));
  assert.ok(notLoaded, 'plan report.txt carries the line');
  const selection = JSON.parse(readFileSync(path.join(root, '.rough-ride', 'runs', plan.runId, 'adversary', 'selection.json'), 'utf8'));
  assert.equal(selection.contract.status, 'not-loaded');

  // attack never detects: fixing the files now changes nothing it reports.
  write(root, 'CLAUDE.md', '# Project\n@AGENTS.md\n');
  const attack = JSON.parse((await runAsync(['attack', '--run', plan.runId, '--json'], { cwd: root, env })).stdout);
  assert.equal(attack.runId, plan.runId, JSON.stringify(attack.stop));
  assert.deepEqual(attack.contract, plan.contract);
  assert.equal(record(root, attack.runId).contract.status, 'not-loaded');
  assert.ok(attack.summaryLines.includes(notLoaded), attack.summaryLines.join('\n'));
  assert.deepEqual(attack.sections.find((s) => s.id === 'contract').lines, [notLoaded]);
  assert.ok(report(root, attack.runId).split('\n').includes(notLoaded));
  // No runner command writes, moves or creates an instruction file.
  assert.equal(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '# Project\n@AGENTS.md\n');
  assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), TEMPLATE);
  assert.equal(existsSync(path.join(root, '.claude')), false);
});

test('the same repository with and without the contract plans the same attacks', async () => {
  const root = project();
  const env = { CI: undefined, GITHUB_ACTIONS: undefined };
  const without = JSON.parse((await runAsync(['plan', 'quick', '--json'], { cwd: root, env })).stdout);
  write(root, 'CLAUDE.md', TEMPLATE);
  const withIt = JSON.parse((await runAsync(['plan', 'quick', '--json'], { cwd: root, env })).stdout);
  const selected = (doc) => JSON.parse(readFileSync(path.join(root, '.rough-ride', 'runs', doc.runId, 'adversary', 'selection.json'), 'utf8')).selected;
  assert.deepEqual([without.contract.status, withIt.contract.status], ['missing', 'current']);
  assert.deepEqual(selected(withIt), selected(without));
  assert.equal(withIt.exitCode, without.exitCode);
});
