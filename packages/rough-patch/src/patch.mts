// A unified diff with 3 lines of context, written without a diff library
// (spec part 2 section 7.7). Lines keep their own endings.

export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type Op = { kind: ' ' | '-' | '+'; line: string };

// Longest common subsequence over whole lines; committed files are small.
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i++]! });
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      ops.push({ kind: '+', line: b[j++]! });
    } else {
      ops.push({ kind: '-', line: a[i++]! });
    }
  }
  return ops;
}

function emit(op: Op): string {
  const body = op.kind + op.line;
  return op.line.endsWith('\n') ? body : body + '\n\\ No newline at end of file\n';
}

// The diff of one file, `path` repo-relative with `/`; empty when unchanged.
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const ops = diffLines(splitLines(before), splitLines(after));
  const changed = ops.map((op, k) => (op.kind === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return '';
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const start = Math.max(0, k - context);
    const end = Math.min(ops.length, k + context + 1);
    const last = hunks.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  let out = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  for (const [start, end] of hunks) {
    let oldLine = 1;
    let newLine = 1;
    for (const op of ops.slice(0, start)) {
      if (op.kind !== '+') oldLine++;
      if (op.kind !== '-') newLine++;
    }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((op) => op.kind !== '+').length;
    const newCount = slice.filter((op) => op.kind !== '-').length;
    out += `@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@\n`;
    out += slice.map(emit).join('');
  }
  return out;
}
