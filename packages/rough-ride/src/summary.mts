// The summary on stdout (spec part 9 section 37): sections in a fixed order,
// each with its line cap and `+N more ... (report.txt)` line, at most 40 lines
// and 8,000 bytes, lines over 240 characters cut unless they are commands or paths.

import type { Note } from './output.mjs';

export const SUMMARY_LINES = 40;
export const SUMMARY_BYTES = 8000;
export const LINE_CUT = 240;
export const BLOCK_START = '--- rough-ride summary (copy this block unchanged) ---';
export const BLOCK_END = '--- end of rough-ride summary ---';

// The fixed priority of the notes section.
const NOTE_ORDER = [
  'extra-node-code', 'automation-detection', 'instruction-file', 'protected-trust', 'manifest', 'void-runs', 'budget',
  'aborted-writes', 'changed-during-run', 'unfinished-run', 'tracing', 'large-diff', 'app-wide-change',
  'accepted-entry-ignored', 'default-changed', 'browser-newer', 'lock-taken-over', 'ignored', 'git-ignored-config',
  'tracked-run-output', 'long-path', 'inside-rough-ride-folder', 'root', 'spec',
];

export function orderNotes(notes: Note[]): Note[] {
  const rank = (id: string) => {
    const i = NOTE_ORDER.indexOf(id);
    return i === -1 ? NOTE_ORDER.length : i;
  };
  return [...notes].map((n, i) => ({ n, i })).sort((a, b) => rank(a.n.id) - rank(b.n.id) || a.i - b.i).map((x) => x.n);
}

export interface SummaryView {
  header: string[];
  // `Nothing attacked:` prints right after the header, in place of the Attacks line.
  nothingAttacked: string | null;
  notes: Note[];
  // One `used as written` line, or the full block: heading, then entries.
  protectedBlock: string[];
  flowLines: string[];
  // Two lines per shown group, at most 5 groups.
  findings: string[][];
  afterFindings: string[];
  attacksLine: string | null;
  notAttacked: string[];
  scopeLine: string | null;
  contract: string | null;
  commands: string[];
  fullReport: string | null;
  runner: string[];
}

export function cutLine(line: string, exempt = false): string {
  return exempt || line.length <= LINE_CUT ? line : line.slice(0, LINE_CUT - 3) + '...';
}

// A section over its cap ends with one overflow line, which counts toward it.
export function capSection(lines: string[], cap: number, overflow: (n: number) => string): string[] {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap - 1), overflow(lines.length - (cap - 1))];
}

// Keeps at most `keep` lines, then one overflow line for the rest.
function keepSome(lines: string[], keep: number, overflow: (n: number) => string): string[] {
  if (lines.length <= keep) return lines;
  return [...lines.slice(0, keep), overflow(lines.length - keep)];
}

export type SectionId = 'header' | 'notes' | 'protected' | 'flows' | 'findings' | 'after' | 'attacks' | 'contract' | 'commands' | 'report' | 'runner' | 'stop';

export interface Section {
  id: SectionId;
  lines: string[];
}

// Keeps the first `cap` lines across sections, dropping sections left empty.
export function capSections(sections: Section[], cap: number): Section[] {
  let room = cap;
  return sections.map((s) => {
    const lines = s.lines.slice(0, Math.max(0, room));
    room -= lines.length;
    return { id: s.id, lines };
  }).filter((s) => s.lines.length > 0);
}

export function renderSummary(view: SummaryView, blockMarkers = false): string[] {
  return renderSections(view, blockMarkers).flatMap((s) => s.lines);
}

// The summary as labelled sections whose lines, joined, are the summary
// (`sections` in every --json document, spec part 13 section 53.2).
export function renderSections(view: SummaryView, blockMarkers = false): Section[] {
  const notes = orderNotes(view.notes).map((n) => n.text);
  // Lines each section may keep before its overflow line; the byte cap lowers
  // them in this order: Not attacked lines, notes, protected entries.
  const keep = { notAttacked: 3, notes: 2, protected: 3 };
  const build = (): Section[] => {
    const noteLines = notes.length <= keep.notes + 1 ? notes : keepSome(notes, keep.notes, (n) => `+${n} more notes (report.txt)`);
    const [heading, ...entries] = view.protectedBlock;
    // Heading plus at most 3 more lines, the overflow line among them.
    const shownEntries = entries.length <= keep.protected ? entries : keepSome(entries, Math.min(keep.protected, 2), (n) => `  +${n} more changes (report.txt)`);
    const protectedLines = heading === undefined ? [] : [heading, ...shownEntries];
    const naLines = view.notAttacked.length <= keep.notAttacked
      ? view.notAttacked
      : keepSome(view.notAttacked, keep.notAttacked, (n) => `+${n} more not attacked (report.txt)`);
    const sections: { id: SectionId; lines: string[]; exempt?: boolean }[] = [
      { id: 'header', lines: [...view.header.slice(0, 3), ...(view.nothingAttacked ? [view.nothingAttacked] : [])] },
      { id: 'notes', lines: noteLines },
      { id: 'protected', lines: protectedLines },
      { id: 'flows', lines: capSection(view.flowLines, 3, (n) => `+${n} more flow lines (report.txt)`) },
      { id: 'findings', lines: view.findings.slice(0, 5).flat() },
      { id: 'after', lines: capSection(view.afterFindings, 3, (n) => `+${n} more (report.txt)`), exempt: true },
      { id: 'attacks', lines: [...(view.attacksLine ? [view.attacksLine] : []), ...naLines, ...(view.scopeLine ? [view.scopeLine] : [])].slice(0, 6) },
      { id: 'contract', lines: view.contract ? [view.contract] : [], exempt: true },
      { id: 'commands', lines: view.commands.slice(0, 3), exempt: true },
      { id: 'report', lines: view.fullReport ? [view.fullReport] : [], exempt: true },
      { id: 'runner', lines: view.runner.slice(0, 3), exempt: true },
    ];
    // The line cap cuts from the end, across sections.
    let room = SUMMARY_LINES;
    return sections.map((s) => {
      const lines = s.lines.map((l) => cutLine(l, s.exempt)).slice(0, Math.max(0, room));
      room -= lines.length;
      return { id: s.id, lines };
    });
  };
  const flat = (secs: Section[]) => secs.flatMap((s) => s.lines);
  const bytes = (secs: Section[]) => Buffer.byteLength((blockMarkers ? [BLOCK_START, ...flat(secs), BLOCK_END] : flat(secs)).join('\n') + '\n');
  let lines = build();
  while (bytes(lines) > SUMMARY_BYTES) {
    if (keep.notAttacked > 0 && view.notAttacked.length > 0) keep.notAttacked--;
    else if (keep.notes > 0 && notes.length > 0) keep.notes--;
    else if (keep.protected > 0 && view.protectedBlock.length > 1) keep.protected--;
    else break;
    lines = build();
  }
  const out = lines.filter((sec) => sec.lines.length > 0);
  if (blockMarkers) {
    out[0] = { ...out[0]!, lines: [BLOCK_START, ...out[0]!.lines] };
    out[out.length - 1] = { ...out[out.length - 1]!, lines: [...out[out.length - 1]!.lines, BLOCK_END] };
  }
  return out;
}

// `500!, 400!, reset! on POST /api/login #1; 2 bad inputs on label "Title"`, cut at 80.
export function membersText(members: { kind: string; fault: string | null; sticky: boolean; key: string; id: string; field?: string }[]): string {
  const faults = new Map<string, string[]>();
  const others: string[] = [];
  const badFields: string[] = [];
  let bad = 0;
  for (const m of members) {
    if (m.kind === 'fault' && m.fault) {
      const list = faults.get(m.key) ?? [];
      const label = `${m.fault}${m.sticky ? '!' : ''}`;
      if (!list.includes(label)) list.push(label);
      faults.set(m.key, list);
    } else if (m.kind === 'timing') {
      const kind = m.id.split('/').at(-1)!;
      others.push(kind === 'double-submit' ? `double-submit on ${m.key}` : `${kind} on ${m.id.split('/').slice(1, -1).join('/')}`);
    }
    else if (m.kind === 'viewport') others.push('viewport 375');
    else if (m.kind === 'bad-input') {
      bad++;
      if (m.field && !badFields.includes(m.field)) badFields.push(m.field);
    } else others.push(m.id.split('/').slice(1).join('/'));
  }
  const parts = [
    ...[...faults].map(([key, list]) => `${list.join(', ')} on ${key}`),
    ...[...new Set(others)],
    ...(bad > 0 ? [`${bad} bad ${bad === 1 ? 'input' : 'inputs'} on ${badFields.join(', ')}`] : []),
  ];
  const text = parts.join('; ');
  return text.length <= 80 ? text : text.slice(0, 77) + '...';
}

// `r03`, `r123`: the attack's ordinal, at least two digits.
export function reproId(ordinal: number): string {
  return `r${String(ordinal).padStart(2, '0')}`;
}
