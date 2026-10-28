// Accepted findings (spec part 9 section 36): entries a person wrote in
// .rough-patch/accepted.yaml, applied only from the reviewed version. A
// matching failed check is removed before grouping; the runner never writes
// or suggests an entry.

import { LineCounter, parseDocument, isMap, isSeq } from 'yaml';
import type { AttackOutcome } from './attacks.mjs';
import { CHECK_RANK, type CheckResult } from './checks.mjs';
import type { CheckedFile } from './files.mjs';
import { isFrameworkInternal, stepKind, type Flow, type FlowRunResult } from './flowrun.mjs';
import { keyOf } from './groups.mjs';
import type { Note } from './output.mjs';

export type EntryState = 'applied' | 'held' | 'ignored';

export interface AcceptedEntry {
  line: number;
  page: string;
  step: string;
  action: string;
  check: string;
  because: string;
  state: EntryState;
  // Attack ids, or `fails with no attack: <flow> step <n>`, this entry matched.
  matched: string[];
}

const identity = (e: Record<string, unknown>) =>
  JSON.stringify([e.page, e.step, e.action, e.check]);

// Every entry in the working file with its line, marked applied when the
// protected-files comparison applies it (`applied` holds those entries), held
// until merged otherwise, or ignored when it names a check this runner lacks.
export function acceptedEntries(file: CheckedFile | null, applied: Record<string, unknown>[], version: string, notes: Note[]): AcceptedEntry[] {
  if (!file) return [];
  const counter = new LineCounter();
  const doc = parseDocument(file.text, { lineCounter: counter });
  const seq = isMap(doc.contents) ? doc.contents.get('accepted', true) : null;
  if (!isSeq(seq)) return [];
  const appliedIds = new Set(applied.map(identity));
  const out: AcceptedEntry[] = [];
  for (const item of seq.items) {
    const value = (isMap(item) ? item.toJSON() : null) as Record<string, unknown> | null;
    if (!value) continue;
    const line = counter.linePos((isMap(item) ? item.range?.[0] : undefined) ?? 0).line;
    const entry: AcceptedEntry = {
      line,
      page: String(value.page),
      step: String(value.step),
      action: String(value.action),
      check: String(value.check),
      because: String(value.because),
      state: appliedIds.has(identity(value)) ? 'applied' : 'held',
      matched: [],
    };
    if (!Object.hasOwn(CHECK_RANK, entry.check)) {
      entry.state = 'ignored';
      notes.push({
        id: 'accepted-entry-ignored',
        text: `Accepted entry ignored: accepted.yaml line ${line} names check ${entry.check}, which rough-patch ${version} doesn't have.`,
      });
    }
    out.push(entry);
  }
  return out;
}

function find(entries: AcceptedEntry[], key: { page: string; step: string; action: string }, check: string): AcceptedEntry | undefined {
  return entries.find((e) => e.state === 'applied' && e.page === key.page && e.step === key.step && e.action === key.action && e.check === check);
}

// Marks a failed attack's accepted checks `accepted`; an attack left with no
// failed check becomes `accepted-finding`.
export function applyAccepted(o: AttackOutcome, flow: Flow, entries: AcceptedEntry[]): void {
  if (o.verdict !== 'failed' || !entries.some((e) => e.state === 'applied')) return;
  const key = keyOf(o, flow);
  let hit = false;
  o.checks = o.checks.map((c): CheckResult => {
    if (c.result !== 'fail') return c;
    const entry = find(entries, key, c.id);
    if (!entry) return c;
    hit = true;
    if (!entry.matched.includes(o.id)) entry.matched.push(o.id);
    return { ...c, result: 'accepted' };
  });
  if (hit && !o.checks.some((c) => c.result === 'fail')) (o as { verdict: string }).verdict = 'accepted-finding';
}

// A fails-with-no-attack line's key: the step where the check first failed,
// that step's first own-origin fetch or XHR as its action, else its control.
export function baselineKey(flow: Flow, run: FlowRunResult, step: number, page: string | null, ownHost: (url: string) => boolean): { page: string; step: string; action: string } {
  const s = flow.steps[step - 1];
  const kind = s ? stepKind(s) : 'goto';
  const q = run.requests.find((r) => r.step === step && (r.resourceType === 'fetch' || r.resourceType === 'xhr') && ownHost(r.url) && !isFrameworkInternal(r.url));
  const action = q ? q.key.replace(/ #\d+$/, '') : s && 'goto' in s ? `goto ${String(s.goto)}` : `control ${run.steps.find((x) => x.index === step)?.label ?? ''}`;
  return { page: page ?? '/', step: kind, action };
}

export function acceptsBaseline(entries: AcceptedEntry[], key: { page: string; step: string; action: string }, check: string, label: string): boolean {
  const entry = find(entries, key, check);
  if (!entry) return false;
  if (!entry.matched.includes(label)) entry.matched.push(label);
  return true;
}

// report.txt's accepted-entries section: one line per entry.
export function acceptedReport(entries: AcceptedEntry[]): string[] {
  return entries.map((e) => {
    const where = `accepted.yaml line ${e.line}: page ${e.page} | step ${e.step} | action ${e.action} | check ${e.check}`;
    if (e.state === 'held') return `${where}: held until merged`;
    if (e.state === 'ignored') return `${where}: ignored (unknown check)`;
    return e.matched.length > 0 ? `${where}: applied, matched ${e.matched.join(', ')}` : `${where}: applied, matched nothing this run`;
  });
}

// record.json's `accepted`.
export function acceptedRecord(entries: AcceptedEntry[], present: boolean) {
  return present ? { file: '.rough-patch/accepted.yaml', entries: entries.map((e) => ({ line: e.line, applied: e.state === 'applied', matched: [...e.matched] })) } : null;
}

// A regression test's failed checks that an applied entry accepts at the
// test's attack point: acceptance never changes the outcome, report.txt only
// says so.
export function testAcceptedNotes(entries: AcceptedEntry[], o: AttackOutcome | null, flow: Flow | undefined, failed: string[]): string[] {
  if (!o || !flow) return [];
  const key = keyOf(o, flow);
  return failed.flatMap((check) => {
    const entry = find(entries, key, check);
    return entry ? [`accepted.yaml line ${entry.line} accepts this check here; the test still checks it.`] : [];
  });
}
