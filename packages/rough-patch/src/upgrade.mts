// Upgraders and the upgrade patch for files below their kind's floor (spec
// part 2 section 7.7). Each format break ships one upgrader; none exists until
// the first break.

import { compareVersions, FORMATS, type FormatKind, type Formats } from './formats.mjs';
import { splitLines, unifiedDiff } from './patch.mjs';

// One whole-line edit, 1-based against the text the upgrader was given.
export type LineEdit =
  | { op: 'replace'; line: number; text: string }
  | { op: 'insert'; after: number; text: string }
  | { op: 'delete'; line: number };

export interface UpgradeResult {
  edits: LineEdit[];
  // Words for upgrade.txt, such as `line 5: step press renamed to key (0.8.0)`.
  described: string[];
  // `line 7 startTimeout (removed in 0.8.0)`: dropped because its feature is gone.
  dropped: string[];
  // A line that can't be mapped exactly keeps the whole file out of the patch.
  handEdits: string[];
}

export interface Upgrader {
  kind: FormatKind;
  // The release whose break this upgrader bridges: it reads files below `to`.
  to: string;
  upgrade(text: string): UpgradeResult;
}

// Each upgrader lives in src/upgraders/<kind>-<to>.mts as `{ kind: '<kind>', to: '<x.y.0>', ... }`
// and is listed here; the formats CI job looks for it there.
export const UPGRADERS: Upgrader[] = [];

export function applyEdits(text: string, edits: LineEdit[]): string {
  const lines = splitLines(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const withEnd = (original: string | undefined, replacement: string) => {
    const end = original?.match(/\r?\n$/)?.[0] ?? '';
    return replacement + end;
  };
  const out: string[] = [];
  const inserts = new Map<number, string[]>();
  for (const edit of edits) {
    if (edit.op === 'insert') inserts.set(edit.after, [...(inserts.get(edit.after) ?? []), edit.text + eol]);
  }
  out.push(...(inserts.get(0) ?? []));
  lines.forEach((line, index) => {
    const n = index + 1;
    const edit = edits.find((e) => e.op !== 'insert' && e.line === n);
    if (edit?.op === 'replace') out.push(withEnd(line, edit.text));
    else if (edit?.op !== 'delete') out.push(line);
    for (const added of inserts.get(n) ?? []) {
      // An insert after a last line with no newline gives that line one.
      if (out.length > 0 && !out.at(-1)!.endsWith('\n')) out[out.length - 1] += eol;
      out.push(added);
    }
  });
  return out.join('');
}

export interface UpgradedFile {
  shown: string;
  kind: FormatKind;
  from: string;
  before: string;
  after: string;
  described: string[];
  dropped: string[];
  handEdits: string[];
}

const EDITOR_COMMENT = /^(# yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/rough-patch\/rough-patch\/v)[0-9]+\.[0-9]+\.[0-9]+(\/packages\/rough-patch\/src\/schemas\/[a-z]+\.schema\.json)/;

// Runs every upgrader after the file's schema in order, then sets schema to
// the kind's current and moves the editor comment's tag.
export function upgradeFile(
  file: { shown: string; kind: FormatKind; text: string; schema: { text: string; line: number } },
  formats: Formats = FORMATS,
  upgraders: Upgrader[] = UPGRADERS,
): UpgradedFile {
  const result: UpgradedFile = {
    shown: file.shown,
    kind: file.kind,
    from: file.schema.text,
    before: file.text,
    after: file.text,
    described: [],
    dropped: [],
    handEdits: [],
  };
  const chain = upgraders
    .filter((u) => u.kind === file.kind && compareVersions(u.to, file.schema.text) > 0)
    .sort((a, b) => compareVersions(a.to, b.to));
  for (const upgrader of chain) {
    const step = upgrader.upgrade(result.after);
    result.after = applyEdits(result.after, step.edits);
    result.described.push(...step.described);
    result.dropped.push(...step.dropped);
    result.handEdits.push(...step.handEdits);
  }
  const current = formats[file.kind].current;
  const lines = splitLines(result.after);
  const edits: LineEdit[] = [];
  lines.forEach((line, index) => {
    const body = line.replace(/\r?\n$/, '');
    const schemaLine = /^(schema:\s*)(["']?)[^\s"'#]+\2(.*)$/.exec(body);
    if (schemaLine) edits.push({ op: 'replace', line: index + 1, text: `${schemaLine[1]}${current}${schemaLine[3]}` });
    else if (EDITOR_COMMENT.test(body)) {
      edits.push({ op: 'replace', line: index + 1, text: body.replace(EDITOR_COMMENT, `$1${current}$2`) });
    }
  });
  result.after = applyEdits(result.after, edits);
  result.described.unshift(`line ${file.schema.line}: schema ${file.schema.text} -> ${current}`);
  return result;
}

export interface UpgradePatch {
  patch: string;
  text: string;
  inPatch: UpgradedFile[];
  byHand: UpgradedFile[];
}

export function buildUpgrade(files: UpgradedFile[], headline: string, applyLine: string): UpgradePatch {
  const inPatch = files.filter((f) => f.handEdits.length === 0);
  const byHand = files.filter((f) => f.handEdits.length > 0);
  const patch = inPatch.map((f) => unifiedDiff(f.shown, f.before, f.after)).join('');
  const lines = [headline, 'Review the patch, then apply it from any folder and commit the result:', `  ${applyLine}`, ''];
  for (const f of files) {
    for (const d of f.described) lines.push(`${f.shown} ${d}`);
    for (const d of f.dropped) lines.push(`Dropped in the patch: ${f.shown} ${d}`);
    for (const d of f.handEdits) lines.push(`Edit by hand: ${f.shown} ${d}`);
  }
  return { patch, text: lines.join('\n') + '\n', inPatch, byHand };
}

