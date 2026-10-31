// The out-of-order attack (spec part 6 sections 32.4 and 33.2): the older
// value's request is held while the newer value is entered, and released once
// the newer answer rendered; latest-response-wins judges what the page shows.

import type { AttackOutcome, PlannedAttack } from './attacks.mjs';
import { judgeAttack, type Judged } from './checks.mjs';
import { holdMsFor, isJsonMedia, MAX_BODY, sha256 } from './faults.mjs';
import { graceEvents } from './kind-fault.mjs';
import { NotApplied, POLL_MS, QUIET_MS, runFlow, stepKind, type AttackKind, type FaultState, type FlowRunResult, type LocatorSpec, type OutOfOrderResult } from './flowrun.mjs';
import type { Request, Route } from 'playwright-core';
import type { KindContext, KindModule } from './kinds.mjs';

export interface OutOfOrderRun {
  step: number;
  // The separate submit step (the next click or press), or the field's own step.
  submitStep: number;
  // `METHOD template` of the carrying GET.
  template: string;
  // The older value: for a fill, null means V followed by this run's ${unique}.
  older: string | null;
  select: boolean;
  // The baseline offset from the step's start to its carrying request.
  offsetMs: number;
}

const COULD_NOT_FILL = 'the field could not be filled while the older request was pending';

function flowRunKind(o: OutOfOrderRun): AttackKind {
  return {
    start: (engine) => {
      const { result, page } = engine;
      const r: OutOfOrderResult = { notApplied: null, aborted: false, releasedAt: null, linesBefore: [], olderOnly: null, newerOnly: null };
      result.outOfOrder = r;
      // The hold and release are recorded as fault events, which the settle grace periods read.
      const f: FaultState = { fired: false, events: [], firedAt: null, notApplied: null, pending: false, givenUp: false, absorbed: false, served: null, holdMs: holdMsFor(engine.timeouts.step) };
      result.fault = f;
      let routeEventAt: number | null = null;
      const faultEvent = (event: string, detail?: string) => {
        const offset = routeEventAt === null ? 0 : Math.round(performance.now() - routeEventAt);
        f.events.push({ at: Date.now(), offsetMs: offset, event, key: o.template, ...(detail ? { detail } : {}) });
      };
      let r1: { route: Route; request: Request } | null = null;
      let r2: Request | null = null;

      // Hold the older value's request, enter the newer value, release the
      // older one once the newer answer rendered. Returns the release time.
      const holdAndRelease = async (locator: ReturnType<typeof engine.locate>, value: string): Promise<number> => {
        const { step: stepTimeout, action: actionTimeout } = engine.timeouts;
        const method = o.template.slice(0, o.template.indexOf(' '));
        let unroute: (() => Promise<void>) | null = null;
        const notApplied = async (why: string): Promise<never> => {
          r.notApplied = why;
          if (r1 && !r.aborted && r.releasedAt === null) await r1.route.continue().catch(() => {});
          await unroute?.();
          throw new NotApplied(why);
        };
        unroute = await engine.route(async (route, request) => {
          const t = request.resourceType();
          if ((t !== 'fetch' && t !== 'xhr') || request.method() !== method || engine.templateFor(request.method(), request.url()) !== o.template) return route.fallback();
          if (r1 === null) {
            r1 = { route, request };
            routeEventAt = performance.now();
            f.fired = true;
            f.firedAt = Date.now();
            faultEvent('held');
            return;
          }
          r2 ??= request;
          return route.fallback();
        });
        const own = engine.resolve(value);
        // The older option goes in by value; the flow's own option by its label, as the flow wrote it.
        const enter = (v: string, isOwn = false) => (o.select ? locator.selectOption(isOwn ? { label: v } : { value: v }, { timeout: actionTimeout }) : locator.fill(v, { timeout: actionTimeout }));
        const submit = o.submitStep !== o.step ? engine.flow.steps[o.submitStep - 1]! : null;
        const pressSubmit = async () => {
          if (!submit) return;
          const k = stepKind(submit);
          const target = engine.locate((submit as Record<string, LocatorSpec>)[k]!);
          if (k === 'press') return target.press((submit as { key: string }).key, { timeout: actionTimeout });
          const until = Date.now() + stepTimeout;
          const disabled = () => target.evaluate((el) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true', undefined, { timeout: 1000 }).catch(() => false);
          while ((await disabled()) && Date.now() < until) await page.waitForTimeout(POLL_MS);
          if (await disabled()) await notApplied('the submit control stayed disabled while the older request was pending');
          return target.click({ timeout: actionTimeout });
        };
        const waitFor = async (check: () => boolean, ms: number) => {
          const until = Date.now() + ms;
          while (!check() && Date.now() < until) await page.waitForTimeout(25);
          return check();
        };
        try {
          await enter(o.older ?? own + engine.unique);
        } catch {
          await notApplied(COULD_NOT_FILL);
        }
        const held = await locator.evaluate((el) => ('value' in el ? String((el as HTMLInputElement).value) : ''), undefined, { timeout: 2000 }).catch(() => null);
        if (held === own) await notApplied("the field kept the flow's own value");
        await pressSubmit();
        if (!(await waitFor(() => r1 !== null, Math.min(o.offsetMs + 1000, stepTimeout)))) await notApplied('the older value sent no request');
        try {
          await enter(own, true);
        } catch {
          await notApplied(COULD_NOT_FILL);
        }
        await pressSubmit();
        if (!(await waitFor(() => r2 !== null, Math.min(o.offsetMs + 1000, stepTimeout)))) await notApplied('the newer value sent no request');
        const newer = await Promise.race([
          (async () => {
            const res = await r2!.response();
            await res?.finished();
            return res;
          })(),
          page.waitForTimeout(10_000).then(() => undefined),
        ]).catch(() => undefined);
        if (newer === undefined) await notApplied('no answer to the newer value within 10 s');
        faultEvent('newer delivered');
        // 500 ms with no DOM mutation, at most S after the newer request was sent.
        const sentAt = Date.now();
        let last = (await engine.snapshot()).mutations;
        let quietSince = Date.now();
        while (Date.now() - quietSince < QUIET_MS && Date.now() - sentAt < stepTimeout) {
          await page.waitForTimeout(POLL_MS);
          const m = (await engine.snapshot()).mutations;
          if (m !== last) {
            last = m;
            quietSince = Date.now();
          }
        }
        r.linesBefore = (await engine.snapshot()).lines;
        if (!r.aborted) {
          const heldFor = Math.round(performance.now() - (routeEventAt ?? performance.now()));
          await r1!.route.continue().catch(() => {});
          r.releasedAt = Date.now();
          faultEvent(`released after ${heldFor} ms`);
        }
        await unroute();
        // Both answers, from response events; bodies stay in memory.
        const bodyOf = async (req: Request) => {
          const res = await Promise.race([req.response(), page.waitForTimeout(10_000).then(() => null)]).catch(() => null);
          if (!res) return null;
          const buf = await res.body().catch(() => null);
          return buf ? { buf, media: (res.headers()['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() } : null;
        };
        const older = r.aborted ? null : await bodyOf(r1!.request);
        const newerBody = await bodyOf(r2!);
        if (older && newerBody && sha256(older.buf) === sha256(newerBody.buf)) await notApplied('both answers were the same');
        const leaves = (b: { buf: Buffer; media: string } | null): Set<string> | null => {
          if (!b || !isJsonMedia(b.media) || b.buf.length > MAX_BODY) return null;
          try {
            const out = new Set<string>();
            const walk = (v: unknown): void => {
              if (typeof v === 'string') {
                if (v.length >= 4 && /\p{L}/u.test(v)) out.add(v);
              } else if (Array.isArray(v)) v.forEach(walk);
              else if (v && typeof v === 'object') Object.values(v).forEach(walk);
            };
            walk(JSON.parse(b.buf.toString('utf8')));
            return out;
          } catch {
            return null;
          }
        };
        const lo = leaves(older);
        const ln = leaves(newerBody);
        if (lo && ln) {
          r.olderOnly = [...lo].filter((x) => !ln.has(x));
          r.newerOnly = [...ln].filter((x) => !lo.has(x));
        }
        return r.releasedAt ?? Date.now();
      };

      return {
        act: async (at, locator) => {
          if (at.index !== o.step || (at.kind !== 'fill' && at.kind !== 'select')) return undefined;
          try {
            // The window starts at the release; the ceiling counts from the step's start.
            return { windowFrom: await holdAndRelease(locator, (at.step as { value: string }).value), ceilingFrom: at.startedAt };
          } catch (error) {
            if (error instanceof NotApplied) throw error;
            throw new NotApplied(COULD_NOT_FILL);
          }
        },
        requestFailed: (request) => {
          if (r1 && request === r1.request && r.releasedAt === null && !r.aborted) {
            r.aborted = true;
            faultEvent('older aborted by the page', request.failure()?.errorText ?? '');
          }
        },
        settling: () => ({ pending: f.pending, holding: false, events: graceEvents(f) }),
        // It ran its own submit step; the flow goes on after it.
        afterWindow: async (at) => (at.index === o.step && o.submitStep !== o.step ? { then: 'continue', skip: o.submitStep } : { then: 'continue' }),
        notApplied: (reason) => {
          r.notApplied ??= reason;
        },
        stopsFlow: (index) => index > o.step && r.releasedAt !== null,
      };
    },
  };
}

// latest-response-wins through (a), (b) or (c), plus no-uncaught-error (an
// AbortError after the page aborted the held request doesn't count), settles
// and no-broken-text (33.2).
export function judgeOutOfOrder(run: FlowRunResult, baseline: FlowRunResult, step: number, skipped: Set<string>): Judged {
  const r = run.outOfOrder;
  return judgeAttack(run, baseline, skipped, {
    name: 'out-of-order',
    gate: !r || r.notApplied !== null ? 'not-applied' : null,
    adjust: { ignoreEvent: (e) => !!r?.aborted && /AbortError/.test(e.text) },
    order: ['latest-response-wins', 'no-uncaught-error', 'settles', 'no-broken-text'],
    own: ({ push }) => {
      const x = r!;
      let latest: string | null = null;
      const o = run.steps.find((s) => s.index === step)?.observation;
      if (x.olderOnly && x.newerOnly && o && x.releasedAt !== null) {
        const after = o.samples.filter((s) => s.at >= x.releasedAt!);
        const shownAfter = [...after.flatMap((s) => s.lines), ...o.after.lines];
        const visibleIn = (lines: string[], leaf: string) => lines.some((l) => l.includes(leaf));
        const appeared = x.olderOnly.find((leaf) => !visibleIn(x.linesBefore, leaf) && visibleIn(shownAfter, leaf));
        if (appeared) latest = `latest-response-wins: "${appeared}" from the older answer appeared after the newer one`;
        else {
          const gone = x.newerOnly.find((leaf) => visibleIn(x.linesBefore, leaf) && !visibleIn(o.after.lines, leaf));
          if (gone) latest = `latest-response-wins: "${gone}" from the newer answer disappeared when the older one arrived`;
        }
      }
      if (!latest && run.stoppedAt !== null && run.failure) {
        latest = `latest-response-wins: step ${run.stoppedAt} failed after the older answer arrived: ${run.failure.message.split('\n')[0]}`;
      }
      push('latest-response-wins', latest);
    },
  });
}

export const outOfOrderKind: KindModule = {
  what: (o) => `an older answer arrived after a newer one on ${o.controlName ?? o.control}`,
  key: (o) => ({ timing: 'out-of-order', page: o.page, request: o.template, field: o.outOfOrder?.fieldKey ?? null }),
  record: (o) => ({ timing: { timing: o.timing, key: o.key, control: o.controlName ?? null, page: o.page }, events: o.events }),
  async run(attack: PlannedAttack, ctx: KindContext): Promise<AttackOutcome> {
    const x = attack.outOfOrder!;
    const run = await runFlow({
      ...ctx.options,
      shots: [attack.step],
      kind: flowRunKind({ step: attack.step, submitStep: x.submitStep, template: attack.template, older: x.older, select: x.select, offsetMs: x.offsetMs }),
    });
    const judged = judgeOutOfOrder(run, ctx.baseline, attack.step, ctx.skipped);
    return {
      ...attack,
      verdict: judged.verdict,
      checks: judged.checks,
      page: attack.page ?? null,
      control: ctx.control(attack.step),
      events: (run.fault?.events ?? []).map((e) => ({ offsetMs: e.offsetMs, event: e.event, ...(e.detail ? { detail: e.detail } : {}) })),
      voided: run.voided,
      served: null,
      notApplied: run.outOfOrder?.notApplied ?? null,
      givenUp: false,
      run,
    };
  },
};
