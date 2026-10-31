// The bad-input attack (spec part 4 sections 21.9 to 21.11, part 5 section
// 23.4 and 23.7): a hostile value replaces one fill or select step, the
// submit step's window classifies the outcome, and a refusal recovers by
// re-filling the form with this run's own values.

import type { AttackOutcome } from './attacks.mjs';
import { fillValues, judgeAttack, type Judged } from './checks.mjs';
import { isFrameworkInternal, NotApplied, POLL_MS, runFlow, stepKind, type AttackKind, type BadInputResult, type BadOutcome, type FlowRunResult, type LocatorSpec, type RequestRecord } from './flowrun.mjs';
import type { KindContext, KindFields, KindModule } from './kinds.mjs';

export interface BadInputRun {
  step: number;
  value: string;
  select: boolean;
  // A multiple select's `placeholder`: no option at all.
  noOption?: boolean;
  submitStep: number;
  // Every attackable step of the form, for reference values and recovery.
  formSteps: number[];
  // `METHOD template` of the baseline run's carrying request, or null.
  carrying: string | null;
  carryingWrite: boolean;
  // `METHOD path` of 5xx answers the baseline run got at the submit step.
  baseline5xx: string[];
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

// A GraphQL error: the JSON request body has a `query` string and the
// response a non-empty top-level `errors` array (21.10 outcome 3).
function graphqlErrors(q: RequestRecord): boolean {
  try {
    const sent = JSON.parse(q.postData ?? '') as { query?: unknown };
    const body = q.body as { errors?: unknown } | undefined;
    return typeof sent.query === 'string' && Array.isArray(body?.errors) && body.errors.length > 0;
  } catch {
    return false;
  }
}

function flowRunKind(bad: BadInputRun): AttackKind {
  return {
    start: (engine) => {
      const { result, page } = engine;
      const r: BadInputResult = { notApplied: null, held: null, linesBefore: [], reference: [], after: [], submitDisabled: false, submittedAt: null, outcome: null, carrying: null };
      result.badInput = r;
      return {
        act: async (at, locator, before) => {
          if (at.index === bad.submitStep && r.notApplied === null) {
            if (at.kind === 'click' || at.kind === 'press') {
              // Reference values: blur the focused element, then read every field of the form.
              await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => {});
              r.reference = await engine.fieldValues(bad.formSteps);
            }
            // A submit that stays disabled through the settle window is skipped, never waited on for 30 s.
            if (at.kind === 'click') {
              const disabled = () => locator.evaluate((el) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true', undefined, { timeout: 1000 }).catch(() => false);
              const until = Date.now() + engine.timeouts.step;
              while ((await disabled()) && Date.now() < until) await page.waitForTimeout(POLL_MS);
              if (await disabled()) r.submitDisabled = true;
            }
            r.submittedAt = Date.now();
          }
          // Skipped: the submit stayed disabled.
          if (at.index === bad.submitStep && r.submitDisabled) return {};
          if (at.index !== bad.step || (at.kind !== 'fill' && at.kind !== 'select')) return undefined;
          // The bad value goes in with fill or selectOption; a throw is Not applied (21.9).
          r.linesBefore = before.lines;
          try {
            if (bad.select) await locator.selectOption(bad.noOption ? [] : { value: bad.value }, { timeout: engine.timeouts.action });
            else await locator.fill(bad.value, { timeout: engine.timeouts.action });
          } catch (error) {
            throw new NotApplied(`fill failed: ${String((error as Error).message ?? error).split('\n')[0]!.slice(0, 120)}`);
          }
          const held = await locator.evaluate((el) => ((el as HTMLElement).isContentEditable ? (el as HTMLElement).innerText : 'value' in el ? String((el as HTMLInputElement).value) : ''), undefined, { timeout: 2000 }).catch(() => null);
          r.held = held;
          const own = engine.resolve((at.step as { value: string }).value);
          if (held !== null && held === own) throw new NotApplied("the field kept the flow's own value");
          return { value: bad.value };
        },
        // A bad input's window ends when its submit step settles (23.4): classify, then recover or go on.
        afterWindow: async (at, window) => {
          if (at.index !== bad.submitStep || r.notApplied !== null) return { then: 'continue' };
          await engine.responses();
          r.after = await engine.fieldValues(bad.formSteps);
          const since = result.requests.filter((q) => q.step >= bad.step && engine.ownHost(q.url) && !isFrameworkInternal(q.url));
          const carrying = bad.carrying
            ? since.find((q) => q.step === bad.submitStep && `${q.key.replace(/ #\d+$/, '')}` === bad.carrying) ?? null
            : since.find((q) => q.step === bad.submitStep && q.navigation && q.method !== 'GET') ?? null;
          r.carrying = carrying ? { method: carrying.method, path: pathOf(carrying.url), status: carrying.status, failure: carrying.failure } : null;
          const crashed = since.some((q) =>
            (q.status !== null && q.status >= 500 && !bad.baseline5xx.includes(`${q.method} ${pathOf(q.url)}`)) ||
            (q.failure !== null && q.status === null && !/ERR_ABORTED/.test(q.failure)));
          const invalids = result.formEvents.invalids.filter((e) => e.step === bad.submitStep);
          const labels = new Set([...window.after.labels, ...window.before.labels]);
          const typed = (r.after ?? []).map((v) => v.value).filter((v): v is string => !!v);
          const newMessage = [...window.samples.flatMap((x) => [...x.live, ...x.lines]), ...window.after.lines]
            .some((l) => !r.linesBefore.includes(l) && !labels.has(l) && !typed.includes(l));
          const status = carrying?.status ?? null;
          const badStep = engine.flow.steps[bad.step - 1]!;
          let outcome: BadOutcome;
          if (crashed) outcome = 'crashed';
          else if (status !== null && [401, 403, 407, 408, 429].includes(status)) outcome = 'inconclusive';
          else if (carrying && status !== null && status >= 400 && status < 500) outcome = 'rejected';
          else if (carrying && status !== null && status < 300 && graphqlErrors(carrying)) outcome = 'rejected';
          else if (carrying && carrying.navigation && status !== null && status < 300 && (await engine.locate((badStep as Record<string, LocatorSpec>)[stepKind(badStep)]!).count().catch(() => 0)) > 0) outcome = 'rejected';
          else if (!carrying && invalids.some((e) => e.browser && e.visible)) outcome = 'blocked-by-browser';
          else if (!carrying && (r.submitDisabled || newMessage)) outcome = 'blocked-by-app';
          else if (!carrying && (at.kind === 'click' || at.kind === 'press') && bad.carryingWrite) outcome = 'silent-refusal';
          else outcome = 'accepted';
          r.outcome = outcome;
          if (outcome === 'inconclusive' || outcome === 'crashed') return { then: 'end' };
          if (outcome === 'accepted') return { then: 'continue' };
          // Recovery (23.7): re-fill every field of the form with this run's own values, then submit again.
          const refill = bad.formSteps.filter((i) => i !== bad.submitStep).map((i) => ({ index: i, step: engine.flow.steps[i - 1]! }));
          return { then: 'recover', steps: [...refill, { index: at.index, step: at.step }], action: `re-fill ${refill.length} ${refill.length === 1 ? 'field' : 'fields'}, then ${at.label}` };
        },
        notApplied: (reason) => {
          r.notApplied = reason;
        },
        // A request to the target failing after the bad fill is judged, never a void.
        excusesFailure: (record) => (record?.step ?? 0) >= bad.step,
        stopsFlow: (index) => index > bad.submitStep && r.outcome === 'accepted',
      };
    },
  };
}

// The four checks every bad input gets, then visible-error-message,
// values-survive and retry-recovers after a refusal (21.10, 21.11).
export function judgeBadInput(run: FlowRunResult, baseline: FlowRunResult, submitStep: number, skipped: Set<string>): Judged {
  const r = run.badInput;
  return judgeAttack(run, baseline, skipped, {
    name: 'bad-input',
    gate: !r || r.notApplied !== null ? 'not-applied' : r.outcome === null ? 'void' : r.outcome === 'inconclusive' ? 'inconclusive' : null,
    order: ['no-uncaught-error', 'settles', 'no-broken-text', 'no-5xx-on-bad-input', 'visible-error-message', 'values-survive', 'retry-recovers'],
    own: ({ push, notEvaluated }) => {
      const b = r!;
      const c = b.carrying;
      push('no-5xx-on-bad-input', b.outcome === 'crashed'
        ? `${c ? `${c.method} ${c.path}` : 'a request'} answered ${c?.status ?? 'no response'} after the bad input`
        : null);
      // A refusal is outcomes 3 to 6; an accepted input followed by a failing step
      // that shows a new message with the values intact counts as blocked by the app.
      const valuesLost = b.reference.find((ref, i) => {
        const now = b.after[i];
        return !ref.password && ref.value !== null && now?.value !== null && now !== undefined && ref.value.trim() !== now.value!.trim();
      });
      const refused = ['rejected', 'blocked-by-browser', 'blocked-by-app', 'silent-refusal'].includes(b.outcome!);
      if (refused) {
        if (b.outcome === 'silent-refusal') push('visible-error-message', 'the submit ran, nothing was sent and no message appeared');
        else if (b.outcome === 'rejected') {
          const step = run.steps.find((x) => x.index === submitStep);
          const o = step?.observation;
          const before = new Set(b.linesBefore);
          const typed = new Set(fillValues(run));
          const shown = o ? [...o.samples.flatMap((x) => [...x.live, ...x.lines]), ...o.after.lines].some((l) => !before.has(l) && !typed.has(l) && !o.after.labels.includes(l)) : false;
          push('visible-error-message', shown || run.dialogs.length > 0 ? null : `no new visible text after ${c ? `${c.method} ${c.path}` : 'the submit'} answered ${c?.status ?? 'nothing'}`);
        } else push('visible-error-message', null);
        // Lengths only: a bad value never reaches a report (21.12).
        if (b.reference.length > 0) push('values-survive', valuesLost ? `${valuesLost.field} held ${valuesLost.value!.length} chars before the submit, then ${b.after[b.reference.indexOf(valuesLost)]?.value?.length ?? 0}` : null);
        else notEvaluated('values-survive', 'not a click or press submit');
        if (run.recovery) push('retry-recovers', run.recovery.passed ? null : (run.recovery.detail ?? 'the flow did not reach its goal'));
        else notEvaluated('retry-recovers', 'no recovery ran');
      } else {
        for (const id of ['visible-error-message', 'values-survive', 'retry-recovers'] as const) notEvaluated(id, `outcome ${b.outcome}`);
      }
    },
  });
}

const REFUSED = ['rejected', 'blocked-by-browser', 'blocked-by-app', 'silent-refusal'];

export const badInputKind: KindModule<KindFields['bad-input']> = {
  what: (o) => `bad input ${o.badInput.inputId} in ${o.badInput.field.name}`,
  symptom: (o, lead) => {
    const bad = o.badInput;
    if (lead?.id === 'no-5xx-on-bad-input') {
      const c = o.run.badInput?.carrying;
      return `${o.template || 'The submit'} answers ${c?.status ?? 'no response'} to bad input ${bad.inputId} in ${bad.field.name}`;
    }
    if (lead?.id === 'visible-error-message' && o.run.badInput?.outcome === 'silent-refusal') {
      return `${o.control} does nothing and shows no message for bad input ${bad.inputId} in ${bad.field.name}`;
    }
    return null;
  },
  // The field's request key, or its accessible name and kind when no request carried its value.
  key: (o) => {
    const b = o.badInput;
    return { badInput: b.inputId, page: b.page, request: b.carrying, field: b.field.key ?? { name: b.field.name, kind: b.field.kind }, ...(b.inputId === 'at-limit' ? { limit: b.limit } : {}) };
  },
  record: (o) => {
    const b = o.badInput;
    const held = o.run.badInput?.held;
    return {
      badInput: {
        id: b.inputId,
        field: b.field,
        preview: `${b.inputId} "${b.preview.text}" (${b.preview.length} chars)`,
        length: b.preview.length,
        held: { length: held?.length ?? null, cutBy: held !== null && held !== undefined && held.length < b.value.length ? 'maxlength' : null },
        outcome: o.run.badInput?.outcome ?? null,
      },
    };
  },
  appId: (attack) => attack.badInput?.inputId ?? null,
  link: (attack) => ({ kind: 'bad-input', endpoints: attack.template ? [attack.template] : [] }),
  nonFinding: (o, lines) => {
    if (o.verdict === 'not-applied') return lines.notApplied();
    const c = o.run.badInput?.carrying;
    if (o.verdict === 'inconclusive') return { kind: 'inconclusive', text: `Inconclusive: ${o.id} (${c?.status ?? '?'} on ${c?.method ?? ''} ${c?.path ?? ''})`, refs: [o.id] };
    if (o.run.stoppedAt !== null) return { kind: 'accepted-flow-stopped', text: `Accepted; flow stopped at step ${o.run.stoppedAt}: ${o.id}`, refs: [o.id] };
    return lines.byVerdict();
  },
  // The page when the bad fill ran; the carrying request, or the submit control when none carried the value.
  groupKey: (o, { suffixes }) => ({ page: o.page ?? '/', action: o.template ? `${o.template}${suffixes(true)}` : `control ${o.control}` }),
  appOutcome: (_attack, run) => {
    const o = run.badInput?.outcome ?? null;
    if (o === null) return { cls: null, shown: 'none' };
    if (REFUSED.includes(o)) return { cls: 'refused', shown: 'refused' };
    if (o === 'accepted') return { cls: 'accepted', shown: 'accepted' };
    return { cls: null, shown: o };
  },
  async run(attack, ctx: KindContext): Promise<AttackOutcome> {
    const b = attack.badInput;
    const run = await runFlow({
      ...ctx.options,
      shots: [b.submitStep],
      kind: flowRunKind({
        step: b.fillStep,
        value: b.value,
        select: b.select,
        noOption: b.noOption,
        submitStep: b.submitStep,
        formSteps: b.formSteps,
        carrying: b.carrying,
        carryingWrite: b.carryingWrite,
        baseline5xx: ctx.baseline.requests.filter((q) => q.step === b.submitStep && q.status !== null && q.status >= 500).map((q) => `${q.method} ${pathOf(q.url)}`),
      }),
    });
    const judged = judgeBadInput(run, ctx.baseline, b.submitStep, ctx.skipped);
    return {
      ...attack,
      verdict: judged.verdict,
      checks: judged.checks,
      page: b.page,
      control: ctx.control(b.submitStep),
      events: [],
      voided: run.voided,
      served: null,
      notApplied: run.badInput?.notApplied ?? null,
      givenUp: false,
      run,
    };
  },
};
