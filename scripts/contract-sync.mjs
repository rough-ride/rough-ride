// The `contract-sync` CI job (spec part 10 section 40.7): the resilience
// contract's template, the README copy, the editions file, the coverage map
// and the tier table stay in step. Run after `npm run build`.
// Usage: node scripts/contract-sync.mjs [--base <ref>]
// --base reads the editions file at that ref, so a frozen entry can't change.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EDITIONS = 'packages/rough-ride/src/contract-editions.json';
const OPENING = /^<!-- resilience-contract edition=([1-9][0-9]{0,3}) -->$/;
const CLOSING = '<!-- /resilience-contract -->';
const MAX_CHARS = 2400;
const MAX_LINES = 16;
// Rule (f)'s words, matched whole and ignoring case, besides the hyphenated exported ids.
const WORDS = ['settles', 'hang', 'reset', 'attack', 'attacked', 'adversary', 'runner', 'finding', 'baseline', 'flow', 'fault', 'sticky', 'one-shot', 'aria', 'role', 'hydrate', 'hydration', 'SSR', 'in-app', 'Retry-After', 'Internal Server Error'];

// A UTF-8 BOM stripped and CRLF turned into LF, as the runner reads instruction files.
export function normalise(bytes) {
  return Buffer.from(bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'), 'utf8');
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The fenced `markdown` block under the README's "Resilience contract" heading, or null.
export function readmeBlock(readme) {
  const lines = readme.split('\n');
  const heading = lines.findIndex((l) => l === '## Resilience contract');
  if (heading === -1) return null;
  const open = lines.findIndex((l, i) => i > heading && l === '```markdown');
  if (open === -1 || lines.slice(heading + 1, open).some((l) => l.startsWith('## '))) return null;
  const close = lines.findIndex((l, i) => i > open && l === '```');
  if (close === -1) return null;
  return lines.slice(open + 1, close).join('\n') + '\n';
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (word) => new RegExp(`(?<![A-Za-z0-9-])${escape(word)}(?![A-Za-z0-9-])`, 'i');

// Every problem in one tree's inputs:
// {template: Buffer, readme: string, editions: [], previous: [] | null, coverage: {}, ids: {checks, faults, inputs, attacks}, tier: {S, viewport}}.
export function contractProblems({ template, readme, editions, previous = null, coverage, ids, tier }) {
  const problems = [];
  const text = template.toString('latin1');
  const lines = text.split('\n');
  const opening = lines.findIndex((l) => OPENING.test(l));
  const closing = lines.indexOf(CLOSING);
  const markerEdition = opening === -1 ? null : Number(OPENING.exec(lines[opening])[1]);
  if (opening === -1 || closing === -1 || closing < opening) problems.push('(b) the template has no opening and closing marker lines');
  const inner = opening === -1 || closing === -1 ? [] : lines.slice(opening + 1, closing);
  const items = inner.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter(Boolean).map(Number);

  // (a) the README block equals the template's bytes.
  const block = readmeBlock(readme);
  if (block === null) problems.push('(a) the README has no fenced markdown block under "## Resilience contract"');
  else if (!Buffer.from(block, 'utf8').equals(template)) problems.push('(a) the README block differs from templates/resilience-contract.md');

  // (b) the editions file and the template.
  if (!Array.isArray(editions) || editions.length === 0) problems.push('(b) contract-editions.json has no entries');
  else {
    editions.forEach((e, i) => {
      if (e.edition !== i + 1) problems.push(`(b) contract-editions.json entry ${i + 1} has edition ${e.edition}; editions must run 1, 2, 3 with none skipped or repeated`);
      if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) problems.push(`(b) edition ${e.edition} has no sha256`);
      if (typeof e.summary !== 'string' || e.summary.trim() === '' || e.summary.includes('\n')) problems.push(`(b) edition ${e.edition} needs a one-line summary`);
      if (!('since' in e) || (e.since !== null && typeof e.since !== 'string')) problems.push(`(b) edition ${e.edition}'s since is null or a version`);
    });
    const hashes = editions.map((e) => e.sha256);
    if (new Set(hashes).size !== hashes.length) problems.push('(b) two editions have the same sha256');
    const lastEntry = editions.at(-1);
    if (lastEntry.sha256 !== sha256(normalise(template))) problems.push(`(b) the template's sha256 ${sha256(normalise(template))} differs from edition ${lastEntry.edition}'s; a changed template needs a new editions entry`);
    if (markerEdition !== null && markerEdition !== lastEntry.edition) problems.push(`(b) the template's marker says edition ${markerEdition}; the last editions entry is ${lastEntry.edition}`);
    for (const before of previous ?? []) {
      if (before.since === null || before.since === undefined) continue;
      const now = editions.find((e) => e.edition === before.edition);
      if (JSON.stringify(now) !== JSON.stringify(before)) problems.push(`(b) edition ${before.edition} is frozen (since ${before.since}) and changed`);
    }
  }

  // (c) the numbers the text shares with the tier table.
  for (const m of text.matchAll(/(\d+) seconds/g)) if (Number(m[1]) !== tier.S / 1000) problems.push(`(c) the text says ${m[1]} seconds; S in the tier table is ${tier.S / 1000} s`);
  for (const m of text.matchAll(/(\d+) px/g)) if (Number(m[1]) !== tier.viewport) problems.push(`(c) the text says ${m[1]} px; the tier table's viewport is ${tier.viewport}`);

  // (d) the coverage map.
  const exported = [...ids.checks, ...ids.faults, ...ids.inputs, ...ids.attacks];
  for (const id of exported) if (!(id in coverage)) problems.push(`(d) ${id} has no coverage entry`);
  const used = new Set();
  for (const [id, parts] of Object.entries(coverage)) {
    if (!exported.includes(id)) problems.push(`(d) the coverage map names ${id}, which is not an exported id`);
    if (!Array.isArray(parts) || parts.length === 0) problems.push(`(d) ${id} maps to nothing`);
    for (const part of Array.isArray(parts) ? parts : []) {
      if (part === 'preamble' || items.includes(part)) used.add(part);
      else problems.push(`(d) ${id} maps to ${JSON.stringify(part)}, which is not an item of the text`);
    }
  }
  for (const n of items) if (!used.has(n)) problems.push(`(d) item ${n} maps to nothing in the coverage map`);

  // (e) the whole text, marker lines included.
  if (/[^\n\x20-\x7e]/.test(text)) problems.push('(e) the text has a byte outside printable ASCII, a CR or a tab');
  if (text.length > MAX_CHARS) problems.push(`(e) the text has ${text.length} characters, over ${MAX_CHARS}`);
  const nonBlank = lines.filter((l) => l.trim() !== '').length;
  if (nonBlank > MAX_LINES) problems.push(`(e) the text has ${nonBlank} non-blank lines, over ${MAX_LINES}`);
  const squashed = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const name of ['roughride', 'weatherproof']) if (squashed.includes(name)) problems.push(`(e) the text names ${name}`);

  // (f) the lines between the markers.
  const body = inner.join('\n');
  for (const word of [...exported.filter((id) => id.includes('-')), ...WORDS]) if (wholeWord(word).test(body)) problems.push(`(f) the text uses the word ${word}`);
  if (body.includes('`')) problems.push('(f) the text has a backtick');
  if (body.includes('://')) problems.push('(f) the text has ://');
  if (/(^|\s)@/.test(body)) problems.push('(f) a word starts with @');
  const digits = inner.map((l) => l.replace(/^\d+\. /, '').replace(/\b10 seconds\b|\b375 px\b|\b4xx\b|\b5xx\b/g, '')).join('\n');
  if (/\d/.test(digits)) problems.push('(f) the text has a digit outside the item numbers, 10 seconds, 375 px, 4xx and 5xx');
  return problems;
}

// This tree's inputs, from the source files and the built runner.
export async function readTree(root = ROOT) {
  const pkg = path.join(root, 'packages', 'rough-ride');
  const dist = (name) => import(pathToFileURL(path.join(pkg, 'dist', name)).href);
  const { CHECK_RANK } = await dist('checks.mjs');
  const { FAULT_IDS } = await dist('faults.mjs');
  const { BAD_INPUT_IDS } = await dist('badinputs.mjs');
  const { TIER_TABLE } = await dist('tiers.mjs');
  const kinds = Object.values(TIER_TABLE.tiers).flatMap((t) => t.kinds);
  const viewport = kinds.find((k) => 'viewport' in k)?.viewport;
  const attacks = [...new Set(kinds.flatMap((k) => ('timing' in k ? [k.timing] : 'viewport' in k ? [`viewport-${k.viewport}`] : [])))];
  return {
    template: readFileSync(path.join(pkg, 'templates', 'resilience-contract.md')),
    readme: readFileSync(path.join(root, 'README.md'), 'utf8'),
    editions: JSON.parse(readFileSync(path.join(root, EDITIONS), 'utf8')),
    coverage: JSON.parse(readFileSync(path.join(pkg, 'test', 'fixtures', 'contract-coverage.json'), 'utf8')),
    ids: { checks: Object.keys(CHECK_RANK), faults: FAULT_IDS, inputs: BAD_INPUT_IDS, attacks },
    tier: { S: TIER_TABLE.constants.S, viewport },
  };
}

// The editions file at a ref: [] when it didn't exist there, null when the ref is unknown.
export function editionsAt(root, ref) {
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root }).status !== 0) return null;
  const shown = spawnSync('git', ['show', `${ref}:${EDITIONS}`], { cwd: root, encoding: 'utf8' });
  return shown.status === 0 ? JSON.parse(shown.stdout) : [];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const at = process.argv.indexOf('--base');
  const base = at === -1 ? null : process.argv[at + 1];
  const tree = await readTree();
  const problems = [];
  let previous = null;
  if (base) {
    previous = editionsAt(ROOT, base);
    if (previous === null) problems.push(`can't read ${base}: fetch full history (actions/checkout fetch-depth: 0)`);
  }
  problems.push(...contractProblems({ ...tree, previous }));
  for (const p of problems) console.log(p);
  if (problems.length > 0) process.exit(1);
  console.log('contract-sync: ok');
}
