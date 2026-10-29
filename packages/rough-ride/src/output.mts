// Text and JSON rules shared by every subcommand (part 9 sections 37 and 38).
// Runner-written text is 7-bit ASCII with no ANSI escape and no \r; only raw
// repository paths and commands may carry other bytes.

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2).replace(
    /[\u007f-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  ) + '\n';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

// Names that come from outside the runner (argv words, later flows, pages and
// requests) print escaped and cut at 40 characters.
export function escapeName(text: string, max = 40): string {
  const escaped = text.replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return escaped.length > max ? escaped.slice(0, max - 3) + '...' : escaped;
}

export function isPlainAscii(text: string): boolean {
  return !/[^\x09\x0a\x20-\x7e]/.test(text);
}

// 0.4s, 48s, 1m52s, 2m05s.
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

export function startClock(): () => number {
  const start = process.hrtime.bigint();
  return () => Number((process.hrtime.bigint() - start) / 1_000_000n);
}

export function headerLine(subcommand: string, durationMs: number, status: string, runId?: string): string {
  const parts = [subcommand ? `rough-ride ${subcommand}` : 'rough-ride', formatDuration(durationMs)];
  if (runId) parts.push(`run ${runId}`);
  parts.push(status);
  return parts.join(' | ');
}

// A line for the summary's notes section, with the stable id `notes[].id` carries.
export interface Note {
  id: string;
  text: string;
}
