// Run records (spec part 9 section 38): one record per executed attack for
// record.json and attacks.jsonl, and the repro files written the moment an
// attack fails. Never a body, a cookie, a ${env} value, or a header value other
// than Next-Action.

import type { AttackOutcome } from './attacks.mjs';
import { DELAY_MS, RETRY_AFTER, sha256 } from './faults.mjs';
import { describeLocator, stepKind, type Flow, type FlowRunResult, type LocatorSpec } from './flowrun.mjs';
import { kindFor } from './kinds.mjs';
import type { FolderState } from './folder.mjs';
import { canonicalJson } from './output.mjs';
import { reproId } from './summary.mjs';
import { redactSecrets } from './secrets.mjs';
import { writeAtomic } from './write.mjs';

// An app-specific check keeps its inline form, so repro can judge it again.
export function failedChecks(o: AttackOutcome): { id: string; evidence: string; check?: Record<string, unknown> }[] {
  return o.checks.filter((c) => c.result === 'fail').map((c) => ({ id: c.id, evidence: c.evidence, ...(c.app ? { check: c.app.inline } : {}) }));
}

// The judged step: the attacked step, or for the viewport the first overflowing one.
function judged(o: AttackOutcome): number {
  return o.step;
}

// ticket 17 item 2's attack key, the form a regression test and a repro store.
export function attackKey(o: AttackOutcome): Record<string, unknown> {
  return kindFor(o).key(o);
}

export function context(): { timezone: string; locale: string } {
  const r = Intl.DateTimeFormat().resolvedOptions();
  return { timezone: r.timeZone, locale: r.locale };
}

export function attackRecord(o: AttackOutcome, meta: { ordinal: number; durationMs: number }, flow?: Flow): Record<string, unknown> {
  const s = flow?.steps[judged(o) - 1];
  const kind = s ? stepKind(s) : null;
  const q = o.kind === 'viewport' ? null : o.run.requests.find((r) => r.step === o.step && r.key.replace(/ #\d+$/, '') === o.template) ?? null;
  return {
    id: o.id,
    ordinal: meta.ordinal,
    repro: reproId(meta.ordinal),
    flow: o.flow,
    kind: o.kind,
    step: { index: judged(o), kind, locator: s && kind !== 'goto' && kind !== null ? describeLocator((s as Record<string, LocatorSpec>)[kind]!) : null },
    ...(q ? {
      request: {
        method: q.method,
        path: (() => {
          try {
            return new URL(q.url).pathname;
          } catch {
            return q.url;
          }
        })(),
        template: o.template,
        n: Number(/#(\d+)$/.exec(o.key)?.[1] ?? 1),
        nextAction: q.nextAction ?? null,
      },
    } : {}),
    ...kindFor(o).record(o),
    page: o.page,
    unique: o.run.unique,
    context: context(),
    verdict: o.verdict,
    stoppedAt: o.run.stoppedAt,
    checks: o.checks.map((c) => (c.app ? { id: c.id, kind: 'app', result: c.result, reason: c.evidence } : { id: c.id, result: c.result, evidence: c.evidence })),
    failedChecks: o.checks.filter((c) => c.result === 'fail').map((c) => c.id),
    durationMs: meta.durationMs,
  };
}

// repros/r<n>.json, r<n>.png (the page when judged) and r<n>-baseline.png (the same step in the baseline run).
// Returns the record as written, so its hash can go into the manifest in the same step.
export function writeRepro(folder: FolderState, runId: string, version: string, o: AttackOutcome, ordinal: number, flow: Flow, baseline: FlowRunResult, holdMs: number, finding: string): Record<string, unknown> {
  const id = reproId(ordinal);
  const step = judged(o);
  const shot = o.run.shots.get(step);
  const baseShot = baseline.shots.get(step);
  if (shot) writeAtomic(folder, ['runs', runId, 'repros', `${id}.png`], shot);
  if (baseShot) writeAtomic(folder, ['runs', runId, 'repros', `${id}-baseline.png`], baseShot);
  const record = {
    runId,
    repro: id,
    finding,
    page: o.page,
    kind: o.kind,
    key: o.key,
    runner: { version },
    flow: { name: flow.name, sha256: sha256(canonicalJson(flow)), parsed: flow },
    attack: attackKey(o),
    unique: o.run.unique,
    context: context(),
    constants: { delayMs: DELAY_MS, holdMs, retryAfter: RETRY_AFTER },
    served: o.served,
    failedChecks: failedChecks(o),
    screenshots: { judged: shot ? `repros/${id}.png` : null, baseline: baseShot ? `repros/${id}-baseline.png` : null },
  };
  const text = canonicalJson(record);
  writeAtomic(folder, ['runs', runId, 'repros', `${id}.json`], text);
  // The file holds the redacted text, so that is what gets hashed.
  return JSON.parse(redactSecrets(text)) as Record<string, unknown>;
}
