// The fault attack (spec part 5 sections 20.5 to 20.11 and 23.3 to 23.7): a
// route on the flow run's own context serves the fault at the attack point,
// the window ends when the attacked step settles, the fault clears, and the
// flow goes on, recovers or ends.

import type { Request, Route } from 'playwright-core';
import type { AttackOutcome, PlannedAttack } from './attacks.mjs';
import { fillValues, judgeAttack, pathBefore, type Judged } from './checks.mjs';
import { DELAY_MS, emptyForm, FAULT_PHRASE, fixedResponse, holdMsFor, isJsonMedia, malformedBody, responseSchema, sha256, type BodyKind, type FaultId } from './faults.mjs';
import { describeStep, isFrameworkInternal, runFlow, type AttackKind, type FaultEvent, type FaultState, type FlowRunResult, type LocatorSpec, type Step, type StepKind } from './flowrun.mjs';
import type { KindContext, KindModule } from './kinds.mjs';
import { hasCredentialHeader } from './secrets.mjs';

export interface FaultAttack {
  fault: FaultId;
  sticky: boolean;
  // `METHOD template` of the attack point, and its place among same-key requests in its step.
  template: string;
  k: number;
  step: number;
  // Body faults: the baseline response's status and media type, and the empty-200 rule.
  baseline?: { status: number | null; mediaType: string | null };
  emptyFormOf?: (live: unknown) => { kind: BodyKind; body: string } | null;
  // Control labels the baseline run showed after the attacked step, for recovery (23.7).
  baselineLabels: string[];
}

// Section 23.6: a fault that delivered a 2xx lets the flow go on; a told,
// unabsorbed fault gets a recovery; anything else ends the attack.
export function afterWindow(fault: FaultId, state: FaultState): 'continue' | 'recover' | 'end' {
  if (!state.fired || state.pending || state.notApplied !== null) return 'end';
  if (fault === 'malformed-json' || fault === 'empty-200' || (fault === 'delay-3s' && !state.givenUp)) return 'continue';
  if (state.absorbed || fault === '401') return 'end';
  if (fault === 'hang' || fault === 'delay-3s') return state.givenUp ? 'recover' : 'end';
  return 'recover';
}

const FAULT_EVENT = /^(served|aborted net|given up|fast-failed|released|forwarded)/;

// The fault events that start a settle grace period (23.2): served responses
// and aborts, give-ups, releases and forwards.
export function graceEvents(state: FaultState): FaultEvent[] {
  return state.events.filter((e) => FAULT_EVENT.test(e.event));
}

function flowRunKind(attack: FaultAttack): AttackKind {
  return {
    // Under delay-3s every step and expect timeout gets 3 s more (20.10).
    actionMs: attack.fault === 'delay-3s' ? DELAY_MS : 0,
    start: async (engine) => {
      const { result, page, context } = engine;
      const f: FaultState = { fired: false, events: [], firedAt: null, notApplied: null, pending: false, givenUp: false, absorbed: false, served: null, holdMs: holdMsFor(engine.timeouts.step) };
      result.fault = f;
      const holdMs = f.holdMs;
      let routeEventAt: number | null = null;
      const faultEvent = (event: string, detail?: string) => {
        const offset = routeEventAt === null ? 0 : Math.round(performance.now() - routeEventAt);
        f.events.push({ at: Date.now(), offsetMs: offset, event, key: attack.template, ...(detail ? { detail } : {}) });
      };
      let armed = false;
      let cleared = false;
      let countInStep = 0;
      // hang: requests the fault holds; delay-3s: requests waiting out the delay.
      const held = new Map<Request, Route>();
      const delayed = new Set<Request>();
      // Requests after a spent one-shot fault: a real 2xx among them absorbed it.
      const oneShotRetries = new Set<Request>();
      let abortingHeld = false;
      let holdTimer: ReturnType<typeof setTimeout> | null = null;
      // values-survive: the fields filled before the attacked click, read right before it.
      let valuesBefore: { field: string; value: string | null; password: boolean }[] | null = null;
      const fieldsBefore = (index: number) => engine.fieldValues(engine.flow.steps.map((_, i) => i + 1).filter((i) => i < index));

      const crossOrigin = (url: string) => {
        try {
          return new URL(url).origin !== new URL(page.url()).origin;
        } catch {
          return false;
        }
      };
      const serveFixed = async (route: Route, request: Request, fault: '500' | '400' | '401' | '429') => {
        const fixed = fixedResponse(fault, crossOrigin(request.url()));
        engine.markServed(request);
        f.served ??= { status: fixed.status, headers: fixed.headers, body: fixed.body };
        faultEvent(`served ${fixed.status}`);
        await route.fulfill({ status: fixed.status, headers: fixed.headers, body: fixed.body }).catch(() => {});
      };
      // malformed-json and empty-200: forwarded exactly once, then the body is rewritten (20.8).
      const serveBody = async (route: Route, request: Request) => {
        let response;
        try {
          response = await route.fetch({ maxRedirects: 0, timeout: holdMs });
        } catch (error) {
          f.notApplied ??= `forwarding failed: ${String((error as Error).message ?? error).split('\n')[0]!.slice(0, 120)}`;
          cleared = true;
          engine.markServed(request);
          faultEvent('aborted net::ERR_FAILED');
          await route.abort('failed').catch(() => {});
          return;
        }
        const status = response.status();
        const media = (response.headers()['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() || null;
        const body = await response.body().catch(() => Buffer.alloc(0));
        const base = attack.baseline;
        const unchanged = async (reason: string) => {
          f.notApplied ??= reason;
          cleared = true;
          faultEvent(`forwarded ${status} ${media ?? 'none'}`, 'unchanged');
          await route.fulfill({ response }).catch(() => {});
        };
        const sameClass = base?.status != null && Math.floor(base.status / 100) === Math.floor(status / 100) && base.mediaType === media;
        if (status < 200 || status >= 300 || !isJsonMedia(media) || body.length === 0 || (base && !sameClass)) {
          return unchanged(`the real response was ${status} ${media ?? 'none'}`);
        }
        let text: string;
        let kind: string;
        if (attack.fault === 'malformed-json') {
          text = malformedBody(body.toString('utf8'));
          kind = 'malformed';
        } else {
          let live: unknown;
          try {
            live = JSON.parse(body.toString('utf8'));
          } catch {
            return unchanged(`the real response was ${status} ${media ?? 'none'}`);
          }
          const form = attack.emptyFormOf?.(live) ?? null;
          if (!form) return unchanged('no empty form of the response');
          if (form.body === JSON.stringify(live)) return unchanged('response already empty');
          text = form.body;
          kind = form.kind;
        }
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers())) {
          if (name === 'content-length' || name === 'content-encoding' || name === 'transfer-encoding') continue;
          headers[name] = value;
        }
        engine.markServed(request);
        const shown = Object.fromEntries(Object.entries(headers).map(([n, v]) => [n, n === 'set-cookie' ? '<redacted>' : v]));
        f.served ??= { status, headers: shown, bodyKind: kind, length: Buffer.byteLength(text), sha256: sha256(text) };
        faultEvent(`forwarded ${status} ${media}`, kind);
        await route.fulfill({ status, headers, body: text }).catch(() => {});
      };
      // A Pending hang: a request still held at H ends the window (23.3).
      const startHoldDeadline = () => {
        if (holdTimer !== null) return;
        holdTimer = setTimeout(() => {
          if (held.size > 0 && !f.givenUp) {
            f.pending = true;
            faultEvent(`pending at ${holdMs / 1000} s`);
          }
        }, holdMs);
      };
      // After the window: held requests are aborted once the page has been judged.
      const releaseHeld = async () => {
        if (holdTimer !== null) clearTimeout(holdTimer);
        if (held.size === 0) return;
        abortingHeld = true;
        faultEvent('aborted after checks');
        for (const route of held.values()) await route.abort('aborted').catch(() => {});
        held.clear();
      };
      // Section 23.7: repeat the step when its control is still visible or it is a
      // fill; otherwise click a control only the failure state shows. Never a reload.
      const recoveryStepFor = async (step: Step, kind: StepKind, labelsNow: string[]): Promise<Step | null> => {
        if (kind === 'fill' || kind === 'select' || kind === 'check') return step;
        if (kind === 'click' || kind === 'press') {
          const spec = (step as Record<string, LocatorSpec>)[kind]!;
          if (await engine.locate(spec).isVisible().catch(() => false)) return step;
        }
        const baseline = new Set(attack.baselineLabels);
        for (const name of [...new Set(labelsNow)].filter((l) => !baseline.has(l) && l.length <= 80)) {
          for (const role of ['button', 'link'] as const) {
            const candidate = page.getByRole(role, { name, exact: true });
            if ((await candidate.count().catch(() => 0)) === 1 && (await candidate.isVisible().catch(() => false))) {
              return { click: { role, name } } as Step;
            }
          }
        }
        return null;
      };

      await engine.route(async (route, request) => {
        const type = request.resourceType();
        const url = request.url();
        if (cleared || (type !== 'fetch' && type !== 'xhr') || !engine.ownHost(url) || isFrameworkInternal(url)) return route.fallback();
        // After a 401 attack point, every credentialed own-origin request gets the 401 (20.6).
        if (attack.fault === '401' && f.fired) {
          const headers = await request.allHeaders().catch(() => ({}) as Record<string, string>);
          if (hasCredentialHeader(headers, engine.credentials)) return serveFixed(route, request, '401');
          return route.fallback();
        }
        if (engine.templateFor(request.method(), url) !== attack.template) return route.fallback();
        let hit = false;
        if (!f.fired) {
          if (armed && engine.owner() === attack.step) {
            countInStep++;
            hit = countInStep === attack.k;
          }
        } else if (attack.sticky) hit = true;
        if (!hit) {
          if (f.fired && !attack.sticky) oneShotRetries.add(request);
          return route.fallback();
        }
        const first = !f.fired;
        if (first) {
          routeEventAt = performance.now();
          f.fired = true;
          f.firedAt = Date.now();
        }
        switch (attack.fault) {
          case '500':
          case '400':
          case '429':
            return serveFixed(route, request, attack.fault);
          case '401':
            await engine.clearOwnCookies();
            return serveFixed(route, request, '401');
          case 'reset':
            engine.markServed(request);
            f.served ??= { aborted: 'net::ERR_CONNECTION_RESET' };
            faultEvent('aborted net::ERR_CONNECTION_RESET');
            return route.abort('connectionreset').catch(() => {});
          case 'hang':
            engine.markServed(request);
            if (f.givenUp) {
              faultEvent('fast-failed', 'net::ERR_TIMED_OUT');
              return route.abort('timedout').catch(() => {});
            }
            f.served ??= { held: true };
            held.set(request, route);
            faultEvent('held');
            startHoldDeadline();
            return;
          case 'delay-3s': {
            f.served ??= { delayed: DELAY_MS };
            delayed.add(request);
            const releaseAt = performance.now() + DELAY_MS;
            while (performance.now() < releaseAt) await new Promise((r) => setTimeout(r, Math.max(1, releaseAt - performance.now())));
            if (!delayed.has(request)) return;
            delayed.delete(request);
            faultEvent(`released after ${DELAY_MS} ms`);
            return route.continue().catch(() => {});
          }
          case 'malformed-json':
          case 'empty-200':
            return serveBody(route, request);
        }
      });

      return {
        beforeStep: async (at) => {
          if (at.index !== attack.step) return;
          armed = true;
          countInStep = 0;
          valuesBefore = at.kind === 'click' ? await fieldsBefore(at.index) : null;
        },
        responded: (request, record) => {
          // A one-shot fault's later request that got a real 2xx: the client retry absorbed it.
          if (oneShotRetries.has(request) && record.status !== null && record.status >= 200 && record.status < 300) f.absorbed = true;
        },
        requestFailed: (request, failure) => {
          // The page gave up on a held or delayed request: from then on the fault is told.
          if ((held.has(request) || delayed.has(request)) && !abortingHeld) {
            held.delete(request);
            delayed.delete(request);
            f.givenUp = true;
            faultEvent('given up by the page', failure);
          }
        },
        // A held request keeps the window open until H, not S (23.2); one still held at H ends it.
        settling: () => ({ pending: f.pending, holding: held.size > 0, events: graceEvents(f) }),
        // The attacked step's window ended: the fault clears (23.5), then the
        // flow goes on, recovers, or the attack ends (23.6).
        afterWindow: async (at, window) => {
          if (at.index !== attack.step) return { then: 'continue' };
          if (valuesBefore) {
            const after = await fieldsBefore(at.index);
            result.values = valuesBefore.map((v, i) => ({ field: v.field, before: v.value, after: after[i]?.value ?? null, password: v.password }));
          }
          // repro --keep-open holds the attack: nothing clears and nothing recovers (14.8).
          if (engine.keepArmed) return { then: 'end' };
          cleared = true;
          if (f.fired && !f.pending) faultEvent('cleared');
          await releaseHeld();
          const next = afterWindow(attack.fault, f);
          if (next === 'end') return { then: 'end' };
          if (next === 'continue') return { then: 'continue' };
          const recoveryStep = await recoveryStepFor(at.step, at.kind, window.after.labels);
          if (!recoveryStep) return { then: 'end', unrecovered: 'no retry path without a reload' };
          return { then: 'recover', steps: [{ index: at.index, step: recoveryStep }], action: describeStep(recoveryStep) };
        },
        // After a fault that delivered a 2xx: `Faulted; flow stopped at step <n>`, never a finding.
        stopsFlow: (index) => index > attack.step && f.fired,
        close: async () => {
          if (!engine.keepArmed) await releaseHeld();
        },
      };
    },
  };
}

// A told failure: the page got an error it can report. malformed-json, empty-200
// and a completed delay-3s delivered a 2xx; a one-shot fault a retry absorbed was
// never seen; a hang or delay is told once the page gave up on it.
export function toldFault(fault: string, state: FaultState): boolean {
  if (state.absorbed) return false;
  if (fault === 'malformed-json' || fault === 'empty-200') return false;
  if (fault === 'hang' || fault === 'delay-3s') return state.givenUp;
  return true;
}

// Judges one fault attack's flow run against the flow's baseline run.
export function judgeFault(attackRun: FlowRunResult, baseline: FlowRunResult, attackedStep: number, skipped: Set<string>, fault = '500'): Judged {
  const state = attackRun.fault;
  const pending = state?.pending ?? false;
  return judgeAttack(attackRun, baseline, skipped, {
    name: 'fault',
    gate: !state?.fired ? 'fault-never-fired' : state.notApplied !== null ? 'not-applied' : null,
    adjust: { pending },
    order: ['no-uncaught-error', 'settles', 'visible-error-message', 'values-survive', 'no-broken-text', 'retry-recovers'],
    own: ({ push, notEvaluated }) => {
      const f = state!;
      const told = toldFault(fault, f);
      // visible-error-message: a told failure (500 or reset, sticky so never absorbed)
      // must show something new from the failed response until the window ends.
      const step = attackRun.steps.find((s) => s.index === attackedStep);
      const firedAt = f.firedAt ?? 0;
      const o = step?.observation;
      let message: string | null = 'no new visible text after the failed request';
      if (o) {
        const before = new Set([...o.before.lines, ...o.before.live]);
        const typed = fillValues(attackRun);
        const labels = new Set([...o.before.labels, ...o.after.labels]);
        const after = o.samples.filter((x) => x.at >= firedAt);
        const newLine = after.flatMap((x) => [...x.live, ...x.lines]).find((l) => !before.has(l) && !labels.has(l) && !typed.some((v) => l === v));
        const dialog = attackRun.dialogs.length > 0;
        // Navigation to another page counts, as after a 401 that moves to sign-in.
        const previous = pathBefore(attackRun, attackedStep);
        const moved = previous !== null && step.path !== null && step.path !== previous;
        if (newLine || dialog || moved) message = null;
      }
      if (pending) notEvaluated('visible-error-message', 'pending hang');
      else if (f.absorbed) notEvaluated('visible-error-message', 'a client retry absorbed the one-shot fault');
      else if (!told) notEvaluated('visible-error-message', 'the fault delivered a 2xx');
      else push('visible-error-message', message);
      // values-survive (22.4 check 6): after a told failure on a click submit step.
      if (pending) notEvaluated('values-survive', 'pending hang');
      else if (!told || attackRun.values === null) notEvaluated('values-survive', told ? 'not a click submit step' : 'the fault was not told');
      else {
        const lost = attackRun.values.find((v) => !v.password && v.after !== null && v.before !== null && v.before.trim() !== v.after.trim());
        push('values-survive', lost ? `${lost.field} held "${lost.before}", then "${lost.after}" after the failed request` : null);
      }
      // retry-recovers (22.4 check 8): after a told, unabsorbed 500, 400, 429 or
      // reset, or a hang or delay-3s the page gave up on.
      const recoverable = told && !f.absorbed && (['500', '400', '429', 'reset'].includes(fault) || ((fault === 'hang' || fault === 'delay-3s') && f.givenUp));
      if (pending) notEvaluated('retry-recovers', 'pending hang');
      else if (!recoverable || attackRun.recovery === null) notEvaluated('retry-recovers', 'no recovery after this fault');
      else push('retry-recovers', attackRun.recovery.passed ? null : (attackRun.recovery.detail ?? 'the flow did not reach its goal'));
    },
  });
}

export const faultKind: KindModule = {
  what: (o) => `${o.template} ${FAULT_PHRASE[o.fault!]}`,
  key: (o) => {
    const q = o.run.requests.find((r) => r.step === o.step && r.key.replace(/ #\d+$/, '') === o.template);
    return { fault: o.fault, sticky: o.sticky, request: o.key, page: q?.pagePath ?? o.page };
  },
  record: (o) => ({ fault: { id: o.fault, sticky: o.sticky, events: o.events, served: o.served } }),
  appOutcome: (attack, run) => {
    if (!run.fault?.fired || run.fault.pending) return { cls: null, shown: 'none' };
    if (run.fault.absorbed) return { cls: null, shown: 'absorbed' };
    if (toldFault(attack.fault!, run.fault)) return { cls: 'told', shown: 'told' };
    return { cls: 'accepted', shown: 'accepted' };
  },
  async run(attack: PlannedAttack, ctx: KindContext): Promise<AttackOutcome> {
    const fault = attack.fault!;
    const { schema, doc } = responseSchema(ctx.docs, attack.template.split(' ')[0]!, attack.template);
    const run = await runFlow({
      ...ctx.options,
      shots: [attack.step],
      kind: flowRunKind({
        fault,
        sticky: attack.sticky,
        template: attack.template,
        k: attack.k,
        step: attack.step,
        ...(attack.baseline ? { baseline: attack.baseline } : {}),
        emptyFormOf: (live: unknown) => emptyForm(live, attack.template, schema, doc),
        baselineLabels: ctx.baseline.steps.find((s) => s.index === attack.step)?.observation?.after.labels ?? [],
      }),
    });
    const judged = judgeFault(run, ctx.baseline, attack.step, ctx.skipped, fault);
    return {
      ...attack,
      verdict: judged.verdict,
      checks: judged.checks,
      page: run.steps.find((s) => s.index === attack.step)?.path ?? null,
      control: ctx.control(attack.step),
      events: (run.fault?.events ?? []).map((e) => ({ offsetMs: e.offsetMs, event: e.event, ...(e.detail ? { detail: e.detail } : {}) })),
      voided: run.voided,
      served: run.fault?.served ?? null,
      notApplied: run.fault?.notApplied ?? null,
      givenUp: run.fault?.givenUp ?? false,
      run,
    };
  },
};
