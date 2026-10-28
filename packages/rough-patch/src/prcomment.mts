// `rough-patch pr-comment` (spec part 13 section 53): the one PR comment body,
// rendered only from the structured fields of the tier's and regress's --json
// documents. It reads the two files and a few GitHub variables, and never
// reads .rough-patch/, runs git, writes a file or reaches the network.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const MARKER = '<!-- rough-patch:pr-comment -->';
const MAX_BYTES = 60_000;
const MAX_ENTRIES = 100;
const SMALL_ENTRIES = 20;

interface Section {
  id: string;
  lines: string[];
}

export interface SummaryDoc {
  status?: string;
  runId?: string | null;
  root?: string | null;
  cwd?: string | null;
  stop?: { kind: string; code: string; lines: string[] } | null;
  protected?: { path: string; kind: string; weakening: boolean; used: string; notApplied: string[] }[];
  protectedLines?: string[] | null;
  sections?: Section[];
  notes?: { id: string; text: string }[];
  findings?: unknown[];
  regress?: { pass: number; fail: number; flaky: number; stale: number; overLimit?: number } | null;
  runner?: { version?: string };
}

export type Loaded = { kind: 'doc'; doc: SummaryDoc } | { kind: 'none' } | { kind: 'unreadable'; version: string };

// UTF-8, or UTF-16 with a BOM (PowerShell 5.1's `>`).
export function decode(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const text = bytes.toString('utf8');
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

// Another 0.x version, or another major from 1.0.0, can't be read.
function sameLine(a: string, b: string): boolean {
  const ma = a.split('.')[0];
  const mb = b.split('.')[0];
  return ma === '0' || mb === '0' ? a === b : ma === mb;
}

export function loadDoc(file: string, own: string): Loaded {
  let text: string;
  try {
    text = decode(readFileSync(file));
  } catch {
    return { kind: 'none' };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { kind: 'none' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { kind: 'none' };
  const version = (doc as SummaryDoc).runner?.version;
  if (typeof version === 'string' && !sameLine(version, own)) return { kind: 'unreadable', version };
  return { kind: 'doc', doc: doc as SummaryDoc };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function tierVerdict(l: Loaded, own: string): string {
  if (l.kind === 'none') return 'no summary';
  if (l.kind === 'unreadable') return `unreadable summary (written by rough-patch ${l.version}; this is ${own})`;
  const d = l.doc;
  switch (d.status) {
    case 'findings': {
      const n = d.findings?.length ?? 0;
      return n > 0 ? plural(n, 'finding') : `0 findings, ${plural(d.regress?.fail ?? 0, 'regression test')} failed`;
    }
    case 'passed': return 'no findings';
    case 'incomplete': return 'no findings, incomplete';
    case 'nothing-to-attack': return 'nothing to attack';
    case 'nothing-attacked': return 'nothing attacked';
    case 'stopped': return `stopped (${d.stop?.code ?? 'unknown'})`;
    case 'interrupted': return 'interrupted';
    case 'internal-error': return 'internal error';
    default: return 'unreadable summary';
  }
}

// Both stopped, with equal codes and equal lines once each document's own run id is a placeholder.
export function stoppedSameWay(a: SummaryDoc, b: SummaryDoc): boolean {
  if (a.status !== 'stopped' || b.status !== 'stopped' || !a.stop || !b.stop || a.stop.code !== b.stop.code) return false;
  const norm = (d: SummaryDoc) => d.stop!.lines.map((line) => (d.runId ? line.split(d.runId).join('<run id>') : line));
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export function regressVerdict(l: Loaded, tier: Loaded, own: string): string | null {
  if (l.kind === 'none') return 'regress: no summary';
  if (l.kind === 'unreadable') return `regress: unreadable summary (written by rough-patch ${l.version}; this is ${own})`;
  const d = l.doc;
  if (d.status === 'stopped') return tier.kind === 'doc' && stoppedSameWay(tier.doc, d) ? 'regress stopped the same way' : `regress stopped (${d.stop?.code ?? 'unknown'})`;
  if (d.status === 'interrupted') return 'regress interrupted';
  if (d.status === 'internal-error') return 'regress internal error';
  const r = d.regress;
  if (!r) return null;
  const over = r.overLimit ?? 0;
  const total = r.pass + r.fail + r.flaky + r.stale + over;
  if (total === 0) return null;
  if (r.fail + r.flaky + r.stale + over === 0) return `regression tests: ${r.pass} passed`;
  const parts = [`${r.fail} failed`, ...(r.flaky ? [`${r.flaky} flaky`] : []), ...(r.stale ? [`${r.stale} stale`] : []), ...(over ? [`${over} over the limit`] : [])];
  return `regression tests: ${parts.join(', ')} of ${total}`;
}

// 53.3's path rewrites: absolute paths under root become repo-relative, a
// file named both ways is named once, and a cwd outside root prints as its
// last component.
export function rewritePaths(line: string, doc: SummaryDoc): string {
  const trim = (p: string) => p.replace(/[\\/]+$/, '');
  const slash = (p: string) => trim(p).split('\\').join('/');
  // Each path as written and with forward slashes, longest first.
  const spellings = (p: string) => [...new Set([trim(p), slash(p), /^[A-Za-z]:/.test(p) ? slash(p).split('/').join('\\') : slash(p)])].sort((a, b) => b.length - a.length);
  let out = line;
  const root = doc.root ? slash(doc.root) : null;
  const cwd = doc.cwd ? slash(doc.cwd) : null;
  const under = (p: string, r: string) => p === r || p.startsWith(r + '/');
  if (doc.cwd && cwd && (!root || !under(cwd, root))) {
    const base = /\\/.test(doc.cwd) ? path.win32.basename(trim(doc.cwd)) : path.posix.basename(cwd);
    for (const sp of spellings(doc.cwd)) out = out.split(sp).join(base);
  }
  if (doc.root && root) {
    for (const sp of spellings(doc.root)) {
      for (const sep of ['/', '\\']) {
        out = out.replace(new RegExp(escapeRe(sp + sep) + '([^\\s)]*)', 'g'), (_m, rel: string) => rel.split('\\').join('/'));
      }
    }
    out = out.replace(/(\S+) \((\1)\)/g, '$1');
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fence(lines: string[]): string[] {
  const longest = Math.max(0, ...lines.map((l) => Math.max(0, ...[...l.matchAll(/`+/g)].map((m) => m[0].length))));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return [`${ticks}text`, ...lines, ticks];
}

// The fenced lines of one document: its sections minus `protected`, minus the
// root note, paths rewritten.
function blockLines(doc: SummaryDoc, drop: string[] = []): string[] {
  const rootNotes = new Set((doc.notes ?? []).filter((n) => n.id === 'root').map((n) => n.text));
  const lines = (doc.sections ?? [])
    .filter((s) => s.id !== 'protected')
    .flatMap((s) => (s.id === 'notes' ? s.lines.filter((l) => !rootNotes.has(l)) : s.lines))
    .filter((l) => !l.startsWith('--- '));
  return lines.filter((l) => !drop.includes(l)).map((l) => rewritePaths(l, doc));
}

function runnerLines(doc: SummaryDoc): string[] {
  return (doc.sections ?? []).filter((s) => s.id === 'runner').flatMap((s) => s.lines);
}

function protectedSource(tier: Loaded, regress: Loaded): SummaryDoc | null {
  if (regress.kind === 'doc' && (regress.doc.protectedLines?.length ?? 0) > 0) return regress.doc;
  if (tier.kind === 'doc' && (tier.doc.protectedLines?.length ?? 0) > 0) return tier.doc;
  return null;
}

// A document's protected changes: its protected[], or the entries of its
// protectedLines when it has none (regress with no tests writes only those).
// Entry lines (two spaces) each with the hint lines (four spaces) under them.
function entryGroups(lines: string[]): string[][] {
  const groups: string[][] = [];
  for (const line of lines) {
    if (/^ {4}/.test(line) && groups.length > 0) groups[groups.length - 1]!.push(line);
    else groups.push([line]);
  }
  return groups;
}

function changeCount(doc: SummaryDoc): number {
  return doc.protected?.length || entryGroups((doc.protectedLines ?? []).slice(1)).length;
}

function protectedBlock(doc: SummaryDoc, maxEntries: number): string[] {
  const [heading, ...rest] = doc.protectedLines!;
  const groups = entryGroups(rest);
  const shown = groups.length > maxEntries ? [...groups.slice(0, maxEntries).flat(), `  +${groups.length - maxEntries} more changes (report.txt)`] : rest;
  const list = doc.protected ?? [];
  const n = changeCount(doc);
  const asWritten = list.length > 0 && list.every((e) => e.used === 'working-tree' && e.notApplied.length === 0);
  const open = list.some((e) => e.weakening || e.used !== 'working-tree' || e.notApplied.length > 0 || e.kind === 'ci');
  return [
    `<details${open ? ' open' : ''}><summary>Protected files: ${plural(n, 'change')}${asWritten ? ', used as written' : ''}</summary>`,
    '',
    ...fence([heading!, ...shown].map((l) => rewritePaths(l, doc))),
    '</details>',
  ];
}

export interface CommentEnv {
  GITHUB_ACTIONS?: string;
  GITHUB_SERVER_URL?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_RUN_ID?: string;
  GITHUB_RUN_ATTEMPT?: string;
  GITHUB_EVENT_PATH?: string;
  GITHUB_SHA?: string;
}

export function headSha(env: CommentEnv): string | null {
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as { pull_request?: { head?: { sha?: unknown } } };
      const sha = event.pull_request?.head?.sha;
      if (typeof sha === 'string' && /^[0-9a-f]{7,}$/.test(sha)) return sha.slice(0, 7);
    } catch {
      // Fall back to GITHUB_SHA.
    }
  }
  return env.GITHUB_SHA && /^[0-9a-f]{7,}$/.test(env.GITHUB_SHA) ? env.GITHUB_SHA.slice(0, 7) : null;
}

export function linksLine(env: CommentEnv, artifactUrl: string | null): string | null {
  if (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return null;
  const repo = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`;
  const log = `[Job log](${repo}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT ?? '1'})`;
  // Only a plain URL under this repository: no space, bracket or control character can add links or lines.
  const artifact = artifactUrl && artifactUrl.startsWith(`${repo}/`) && /^[\x21-\x7e]+$/.test(artifactUrl) && !/[()<>\[\]]/.test(artifactUrl) ? `[Run output](${artifactUrl}) (kept 14 days) | ` : '';
  return artifact + log;
}

export function renderComment(options: { tier: 'quick' | 'standard'; tierDoc: Loaded; regressDoc: Loaded; own: string; env: CommentEnv; artifactUrl: string | null }): string {
  const { tier, tierDoc, regressDoc, own, env } = options;
  const build = (maxEntries: number): string => {
    const verdict = [`rough-patch ${tier}`, tierVerdict(tierDoc, own)];
    const rv = regressVerdict(regressDoc, tierDoc, own);
    if (rv) verdict.push(rv);
    const source = protectedSource(tierDoc, regressDoc);
    const countDoc = source ?? (regressDoc.kind === 'doc' && (regressDoc.doc.protected?.length ?? 0) > 0 ? regressDoc.doc : tierDoc.kind === 'doc' ? tierDoc.doc : null);
    const count = source ? changeCount(source) : (countDoc?.protected?.length ?? 0);
    if (count > 0) verdict.push(`${plural(count, 'protected file change')}`);
    const sha = headSha(env);
    if (sha) verdict.push(`commit ${sha}`);
    verdict.push('non-blocking');
    const out = [verdict.join(' | '), ''];
    if (source) out.push(...protectedBlock(source, maxEntries), '');
    if (tierDoc.kind === 'doc') out.push(...fence(blockLines(tierDoc.doc)), '');
    else if (tierDoc.kind === 'none') out.push(`rough-patch ${tier} wrote no summary: its step ended first (step timeout, cancel or crash). See the job log.`, '');
    if (regressDoc.kind === 'none') out.push('rough-patch regress wrote no summary: its step ended first (step timeout, cancel or crash). See the job log.', '');
    else if (regressDoc.kind === 'doc') {
      const r = regressDoc.doc;
      const noTests = !r.regress || r.regress.pass + r.regress.fail + r.regress.flaky + r.regress.stale + (r.regress.overLimit ?? 0) === 0;
      const same = tierDoc.kind === 'doc' && stoppedSameWay(tierDoc.doc, r);
      if (!(r.status === 'passed' || (r.status !== 'stopped' && noTests) || same)) {
        const drop = tierDoc.kind === 'doc' ? runnerLines(tierDoc.doc) : [];
        const tierRunner = drop.join('\n');
        const own_ = runnerLines(r);
        out.push(...fence(blockLines(r, own_.join('\n') === tierRunner ? own_ : [])), '');
      }
    }
    const links = linksLine(env, options.artifactUrl);
    if (links) out.push(links);
    else if (out[out.length - 1] === '') out.pop();
    out.push(MARKER);
    return out.join('\n') + '\n';
  };
  const body = build(MAX_ENTRIES);
  return Buffer.byteLength(body) > MAX_BYTES ? build(SMALL_ENTRIES) : body;
}
