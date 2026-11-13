// node benchmark/comparison/sensitivity.mjs
// Precision and false alarms per run under two readings that favour rough-ride:
// A counts every "no retry" or "no timeout" issue as a real defect (the
// checklist every arm got asks for both); B leaves out the bed Delete button
// that the app disables on purpose (a seed-data interaction). Recall does not change.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ARMS, RESULTS } from './lib.mjs';

const s = JSON.parse(readFileSync(path.join(RESULTS, 'summary.json'), 'utf8'));
const runs = Object.fromEntries(ARMS.map((a) => [a, s.per[a].runs]));
const isRetryOrTimeout = (issue) => /no-retry|retry-after|no-request-timeout|requests-no-timeout|no-timeout/.test(issue ?? '');
const isDeleteBed = (issue) => /delete-(bed|stays)|beds-delete/.test(issue ?? '');
const readings = {
  asJudged: (r) => r.cls,
  A: (r) => (r.cls.startsWith('false-') && isRetryOrTimeout(r.issue) ? 'extra-confirmed' : r.cls),
  B: (r) => (isDeleteBed(r.issue) ? 'dropped' : r.cls),
  AB: (r) => (isDeleteBed(r.issue) ? 'dropped' : r.cls.startsWith('false-') && isRetryOrTimeout(r.issue) ? 'extra-confirmed' : r.cls),
};
const out = {};
for (const [name, cls] of Object.entries(readings)) {
  out[name] = {};
  for (const arm of ARMS) {
    const rs = s.rows.filter((r) => r.arm === arm).map((r) => ({ ...r, c: cls(r) })).filter((r) => r.c !== 'dropped');
    const real = rs.filter((r) => r.c.startsWith('planted') || r.c === 'extra-confirmed').length;
    const fa = rs.filter((r) => r.c.startsWith('false-')).length;
    const decided = real + fa;
    out[name][arm] = { findings: rs.length, precision: decided ? +(real / decided).toFixed(3) : null, falseAlarmsPerRun: +(fa / runs[arm]).toFixed(2), distinctRealExtras: new Set(rs.filter((r) => r.c === 'extra-confirmed').map((r) => r.issue)).size };
  }
}
writeFileSync(path.join(RESULTS, 'sensitivity.json'), JSON.stringify(out, null, 2) + '\n');
for (const [name, v] of Object.entries(out)) console.log(name, JSON.stringify(v));
