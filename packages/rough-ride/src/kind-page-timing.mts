// The page timing attacks (spec part 6 sections 32.2 and 32.5 to 32.8):
// refresh, back and signed-out-reload at a page entry. After the entry step
// settles the runner adds its own reload, back or forward steps.

import type { AttackOutcome, PlannedAttack } from './attacks.mjs';
import { judgeAttack, type Judged } from './checks.mjs';
import { fixedResponse } from './faults.mjs';
import { GO_LABEL_PREFIX, NotApplied, RELOAD_LABEL, runFlow, type AttackKind, type FlowRunResult, type PageTimingResult, type StepRecord } from './flowrun.mjs';
import type { KindContext, KindModule } from './kinds.mjs';
import { hasCredentialHeader } from './secrets.mjs';

type PageKind = 'refresh' | 'back' | 'signed-out-reload';

function flowRunKind(kind: PageKind, step: number, previous: string | null): AttackKind {
  return {
    start: (engine) => {
      const r: PageTimingResult = { notApplied: null, events: [], documentStatus: null, navigationError: null, removed: 0, served401: 0 };
      engine.result.pageTiming = r;
      const ev = (event: string, detail?: string) => r.events.push({ at: Date.now(), event, ...(detail ? { detail } : {}) });
      const navigate = (index: number, what: 'reload' | 'back' | 'forward') => {
        // Reloading a page that a form post produced would resend the write (32.2).
        if (what === 'reload' && engine.documentMethod() !== 'GET') {
          ev('form post blocked');
          throw new NotApplied('the reload would resend a form post');
        }
        return engine.navigate(index, what, {
          beforeUnload: () => ev('beforeunload accepted'),
          arrived: (nav) => {
            if (nav.error !== null) r.navigationError = nav.error;
            if (nav.status !== null) r.documentStatus = nav.status;
            if (nav.redirected !== null) ev(`redirected ${nav.redirected}`);
            if (what === 'reload') ev(`reloaded ${r.documentStatus ?? r.navigationError ?? 'no response'}`);
            else ev(`went ${what} ${nav.path ?? ''}`);
          },
        });
      };
      return {
        afterWindow: async (at, window) => {
          if (at.index !== step || r.events.length > 0) return { then: 'continue' };
          const entryPath = window.path;
          if (kind === 'signed-out-reload') {
            // The 401 fault's session loss, exactly (20.6), then a reload; the attack ends there.
            const creds = engine.credentials;
            const cookies = (await engine.context.cookies()).filter((c) => engine.ownHost(`http://${c.domain.replace(/^\./, '')}/`));
            r.removed = cookies.filter((c) => creds.includes(c.value)).length;
            await engine.clearOwnCookies();
            ev(`cookies deleted ${cookies.length}`);
            await engine.route(async (route, request) => {
              const t = request.resourceType();
              if ((t !== 'fetch' && t !== 'xhr') || !engine.ownHost(request.url())) return route.fallback();
              const headers = await request.allHeaders().catch(() => ({}) as Record<string, string>);
              if (!hasCredentialHeader(headers, creds)) return route.fallback();
              r.served401++;
              ev('served 401');
              const fixed = fixedResponse('401', false);
              return route.fulfill({ status: fixed.status, headers: fixed.headers, body: fixed.body }).catch(() => {});
            });
            const { ready } = await navigate(at.index, 'reload');
            if (!ready && engine.readyKind === 'expression') throw new NotApplied('the ready expression stayed false after signing out');
            if (r.removed === 0 && r.served401 === 0) throw new NotApplied('no credential was removed or refused');
            return { then: 'end' };
          }
          if (kind === 'refresh') {
            await navigate(at.index, 'reload');
          } else {
            const back = await navigate(at.index, 'back');
            if (back.path === entryPath) throw new NotApplied(`the page stayed on ${entryPath}`);
            if (back.path !== previous) throw new NotApplied(`the back step went to ${back.path}, not ${previous}`);
            const forward = await navigate(at.index, 'forward');
            if (forward.path !== entryPath) throw new NotApplied(`the forward step went to ${forward.path}, not ${entryPath}`);
          }
          return { then: 'continue' };
        },
        notApplied: (reason) => {
          r.notApplied = reason;
        },
        // The runner's own reload, back or forward failing is judged by no-uncaught-error, never a void.
        excusesFailure: (record) => record?.navigation ?? false,
        stopsFlow: (index) => index > step && r.events.length > 0,
      };
    },
  };
}

// The runner's own reload, back and forward steps (32.2). They share the entry
// step's index, so the baseline run's step at that index is a different step.
const runnerNavigation = (step: StepRecord): boolean => step.label === RELOAD_LABEL || step.label.startsWith(GO_LABEL_PREFIX);

// no-uncaught-error with the document additions, settles with the runner's
// own steps, and no-broken-text (32.8). Errors a baseline run's full load of
// the same page template also got don't count.
export function judgePageTiming(run: FlowRunResult, baseline: FlowRunResult, skipped: Set<string>, fullLoadErrors: string[]): Judged {
  const r = run.pageTiming;
  const expected = new Set(fullLoadErrors);
  const documentError = (p: PageTimingResult): string | null =>
    p.documentStatus !== null && p.documentStatus >= 500 && !expected.has(`document ${p.documentStatus}`) ? `the document answered ${p.documentStatus} after the runner's navigation`
    : p.navigationError && !expected.has(p.navigationError) ? `the navigation failed with ${p.navigationError}`
    : null;
  return judgeAttack(run, baseline, skipped, {
    name: 'page-timing',
    gate: !r || r.notApplied !== null ? 'not-applied' : r.events.length === 0 ? 'fault-never-fired' : null,
    adjust: { ignoreEvent: (e) => expected.has(e.text), leadingError: r ? documentError(r) : null, ownStep: runnerNavigation },
    order: ['no-uncaught-error', 'settles', 'no-broken-text'],
  });
}

export const pageTimingKind: KindModule = {
  what: (o) => (o.timing === 'refresh' ? `a reload of ${o.page}` : o.timing === 'back' ? `back then forward to ${o.page}` : `a signed-out reload of ${o.page}`),
  key: (o) => ({ timing: o.timing, page: o.page, entry: o.entry?.k }),
  record: (o) => ({ timing: { timing: o.timing, key: o.key, control: o.controlName ?? null, page: o.page }, events: o.events }),
  appId: (attack) => attack.timing ?? null,
  link: (attack) => ({ kind: 'timing', endpoints: attack.writeKeys ?? [attack.template] }),
  nonFinding: (o, lines) => (o.verdict === 'not-applied' ? lines.notApplied() : lines.flowStopped() ?? lines.byVerdict()),
  groupKey: (o) => ({ page: o.page ?? '/', action: o.template }),
  async run(attack: PlannedAttack, ctx: KindContext): Promise<AttackOutcome> {
    const run = await runFlow({ ...ctx.options, shots: [attack.step], kind: flowRunKind(attack.timing as PageKind, attack.step, attack.entry?.previous ?? null) });
    // Errors that a baseline full load of the same page template also got never count.
    const fullLoad = ctx.baseline.pages.filter((p) => p.path === attack.page && p.entry === 'full-load');
    const fullLoadErrors = fullLoad.flatMap((p) => ctx.baseline.pageEvents.filter((e) => e.step === p.step).map((e) => e.text));
    const judged = judgePageTiming(run, ctx.baseline, ctx.skipped, fullLoadErrors);
    return {
      ...attack,
      verdict: judged.verdict,
      checks: judged.checks,
      page: attack.page ?? null,
      control: ctx.control(attack.step),
      events: (run.pageTiming?.events ?? []).map((e) => ({ offsetMs: e.at - (run.pageTiming!.events[0]?.at ?? e.at), event: e.event, ...(e.detail ? { detail: e.detail } : {}) })),
      voided: run.voided,
      served: null,
      notApplied: run.pageTiming?.notApplied ?? null,
      givenUp: false,
      run,
    };
  },
};
