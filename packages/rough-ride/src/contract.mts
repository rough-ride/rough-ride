// The resilience contract's status (spec part 10 sections 40.4 and 40.5):
// which edition the four root instruction files carry, against the edition
// in this copy's own template. Advice only: the status never changes
// selection, attacks, verdicts or the exit code, and nothing here writes a file.

import { lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, inside, printed } from '../hooks/path-check.mjs';
import { decodeUtf8 } from './adversary.mjs';

// At the git root, in this order. CLAUDE.local.md is never read, not even to see whether it exists.
export const CONTRACT_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', '.claude/AGENTS.md'] as const;
const CLAUDE_FILES = ['CLAUDE.md', '.claude/CLAUDE.md'];
const MAX_BYTES = 1024 * 1024;
const OPENING = /^<!-- resilience-contract edition=([1-9][0-9]{0,3}) -->$/;
const DECLINED = '<!-- resilience-contract declined -->';

export const TEMPLATE_FILE = fileURLToPath(new URL('../templates/resilience-contract.md', import.meta.url));
const EDITIONS_FILE = fileURLToPath(new URL('./contract-editions.json', import.meta.url));

export type ContractStatusName = 'declined' | 'not-loaded' | 'current' | 'newer' | 'older' | 'removed' | 'missing';

export interface ContractStatus {
  status: ContractStatusName;
  // Git-root-relative, or null.
  file: string | null;
  edition: number | null;
  // The edition in this runner's template.
  current: number;
  // not-loaded: the instruction file Claude Code reads instead.
  reader?: string;
  // removed: the base ref as shown, and the merge base.
  base?: { shown: string; sha: string };
}

type Marker = { kind: 'edition'; edition: number } | { kind: 'declined' };

// The first marker line in a text, each line trimmed.
export function firstMarker(text: string | null): Marker | null {
  if (text === null) return null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === DECLINED) return { kind: 'declined' };
    const m = OPENING.exec(line);
    if (m) return { kind: 'edition', edition: Number(m[1]) };
  }
  return null;
}

// A whitespace-delimited import token outside fenced code.
export function importsFile(text: string | null, file: string): boolean {
  if (text === null) return false;
  const tokens = file === 'AGENTS.md' ? ['@AGENTS.md', '@./AGENTS.md'] : [`@${file}`, `@./${file}`];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]!;
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (fence === null && line.split(/\s+/).some((t) => tokens.includes(t))) return true;
  }
  return false;
}

// Text a file holds, with a UTF-8 BOM stripped and CRLF turned into LF; null when it isn't UTF-8.
function decode(bytes: Buffer | null): string | null {
  if (bytes === null || bytes.length > MAX_BYTES) return null;
  return decodeUtf8(bytes);
}

export interface InstructionRead {
  exists: boolean;
  bytes: Buffer | null;
}

// A link is followed only to a target inside the git root; only regular files of at most 1 MiB are read.
export function readInstruction(root: string, rel: string): InstructionRead {
  const full = path.join(root, ...rel.split('/'));
  try {
    lstatSync(full);
  } catch {
    return { exists: false, bytes: null };
  }
  try {
    const real = canon(full);
    if (!inside(real, root)) return { exists: true, bytes: null };
    const stat = statSync(real);
    if (!stat.isFile() || stat.size > MAX_BYTES) return { exists: true, bytes: null };
    return { exists: true, bytes: readFileSync(real) };
  } catch {
    return { exists: true, bytes: null };
  }
}

// The status from what the four files hold now and at the merge base; first match wins.
export function contractStatus(
  now: Map<string, InstructionRead>,
  base: Map<string, Buffer | null> | null,
  baseRef: { shown: string; sha: string } | null,
  current: number,
): ContractStatus {
  const found = CONTRACT_FILES.map((file) => ({ file, marker: firstMarker(decode(now.get(file)?.bytes ?? null)) })).filter((x) => x.marker !== null);
  const first = found[0];
  if (first) {
    if (first.marker!.kind === 'declined') return { status: 'declined', file: first.file, edition: null, current };
    const edition = first.marker!.edition;
    // The marker is only in an AGENTS file when the first file holding one is an AGENTS file.
    if (!CLAUDE_FILES.includes(first.file)) {
      const readers = CLAUDE_FILES.filter((f) => now.get(f)?.exists);
      if (readers.length > 0 && !readers.some((r) => importsFile(decode(now.get(r)!.bytes), first.file))) {
        return { status: 'not-loaded', file: first.file, edition, current, reader: readers[0]! };
      }
    }
    return { status: edition === current ? 'current' : edition > current ? 'newer' : 'older', file: first.file, edition, current };
  }
  if (base && baseRef) {
    for (const file of CONTRACT_FILES) {
      const marker = firstMarker(decode(base.get(file) ?? null));
      if (marker?.kind === 'edition') return { status: 'removed', file, edition: marker.edition, current, base: baseRef };
    }
  }
  return { status: 'missing', file: null, edition: null, current };
}

// The edition this copy ships, parsed from its own template; null when the template can't be read.
export function templateEdition(file = TEMPLATE_FILE): number | null {
  try {
    const marker = firstMarker(decode(readFileSync(file)));
    return marker?.kind === 'edition' ? marker.edition : null;
  } catch {
    return null;
  }
}

// `<summary>` for an edition, from this copy's own dist/contract-editions.json.
export function editionSummary(edition: number, file = EDITIONS_FILE): string | null {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as { edition: number; summary: string }[];
    return list.find((e) => e.edition === edition)?.summary ?? null;
  } catch {
    return null;
  }
}

// The read-once step's detection (40.4): the four files now, and their
// merge-base versions from the protected files' single cat-file read.
export function detectContract(
  root: string,
  base: Map<string, Buffer | null> | null,
  baseRef: { shown: string; mergeBase: string } | null,
  read: (root: string, rel: string) => InstructionRead = readInstruction,
): ContractStatus | null {
  const current = templateEdition();
  if (current === null) return null;
  const now = new Map(CONTRACT_FILES.map((f) => [f, read(root, f)]));
  return contractStatus(now, base, baseRef ? { shown: baseRef.shown, sha: baseRef.mergeBase } : null, current);
}

// What the run record and the JSON summary carry.
export function contractJson(c: ContractStatus | null): { status: ContractStatusName; file: string | null; edition: number | null; current: number } | null {
  return c === null ? null : { status: c.status, file: c.file, edition: c.edition, current: c.current };
}

export interface LineOptions {
  version: string;
  // CI mode: no `(also at ...)` suffix.
  ci: boolean;
  templateFile?: string;
  summary?: string | null;
}

// The fixed line for missing, older, not-loaded and removed; null for the rest (40.5).
export function contractLine(c: ContractStatus | null, o: LineOptions): string | null {
  if (c === null) return null;
  const url = `https://github.com/rough-ride/rough-ride/blob/v${o.version}/docs/resilience-contract.md#the-text` +
    (o.ci ? '' : ` (also at ${printed(o.templateFile ?? TEMPLATE_FILE)})`);
  const alone = 'agents leave instruction files alone.';
  switch (c.status) {
    case 'missing':
      return 'Resilience contract: not in the root CLAUDE.md, .claude/CLAUDE.md, AGENTS.md or .claude/AGENTS.md. Pasted into the root CLAUDE.md, it tells coding agents which failures to design for; it changes nothing rough-ride attacks or judges.' +
        ` Text: ${url}. The user decides; ${alone}`;
    case 'older': {
      const summary = o.summary === undefined ? editionSummary(c.current) : o.summary;
      return `Resilience contract: ${c.file} has edition ${c.edition}; rough-ride ${o.version} ships edition ${c.current}${summary ? ` (${summary})` : ''}.` +
        ` The user replaces the section between its two marker lines with the text at ${url}; ${alone}`;
    }
    case 'not-loaded': {
      const reader = c.reader === '.claude/CLAUDE.md' ? '.claude/CLAUDE.md' : 'the root CLAUDE.md';
      const into = c.reader === '.claude/CLAUDE.md' ? '.claude/CLAUDE.md' : 'CLAUDE.md';
      return `Resilience contract: found in ${c.file}, but Claude Code reads ${reader} instead, which doesn't import ${c.file} (unless Project instructions is set to claude-md-and-agents-md).` +
        ` The user moves the section into ${into} or adds the line @${c.file} to it; ${alone}`;
    }
    case 'removed':
      return `Resilience contract: ${c.file} had edition ${c.edition} at ${c.base!.shown} (${c.base!.sha.slice(0, 7)}); the working tree has none. The user decides whether it goes back; ${alone}`;
    default:
      return null;
  }
}

// The tier summary's Contract section (40.5): plan prints none; missing only
// beside a shown finding and never in CI mode. report.txt carries every line.
export function summaryContractLine(c: ContractStatus | null, line: string | null, o: { plan: boolean; shownFindings: number; ci: boolean }): string | null {
  if (o.plan || c === null) return null;
  if (c.status === 'missing' && (o.shownFindings === 0 || o.ci)) return null;
  return line;
}
