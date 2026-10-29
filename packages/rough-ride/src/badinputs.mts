// Bad inputs (spec part 5 section 21): field kinds from element facts, request
// evidence and OpenAPI, the fixed value list, inputs the browser is certain to
// block, and the round-robin order each tier runs. Values never reach a report:
// only an input id, a short escaped preview and the length.

import { describeLocator, stepKind, type FieldFacts, type Flow, type FlowRunResult, type LocatorSpec, type RequestRecord } from './flowrun.mjs';
import type { Form } from './forms.mjs';
import type { OpenApiDoc } from './openapi.mjs';

export type FieldKind = 'select' | 'password' | 'email' | 'number' | 'numeric text' | 'date' | 'time-like' | 'date text' | 'search' | 'textarea' | 'text';

export interface SchemaProp {
  type?: string | string[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  required?: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

// Section 21.4's kinds, first match wins; the element's native type always wins.
export function fieldKind(f: FieldFacts, evidence: { jsonNumber: boolean }, schema: SchemaProp | null, flowValue: string): FieldKind {
  const type = f.type;
  const textual = f.tag === 'input' && (type === null || ['text', 'tel', 'url', 'search', 'email'].includes(type));
  const schemaType = Array.isArray(schema?.type) ? schema!.type : schema?.type ? [schema.type] : [];
  if (f.tag === 'select') return 'select';
  if (type === 'password') return 'password';
  if (type === 'email' || (textual && type !== 'search' && (f.inputmode === 'email' || /\bemail\b/.test(f.autocomplete ?? '') || schema?.format === 'email'))) return 'email';
  if (type === 'number') return 'number';
  if (textual && type !== 'search' && (f.inputmode === 'numeric' || f.inputmode === 'decimal' || f.role === 'spinbutton' || evidence.jsonNumber || schemaType.includes('integer') || schemaType.includes('number'))) return 'numeric text';
  if (type === 'date' || type === 'datetime-local') return 'date';
  if (type === 'time' || type === 'month' || type === 'week') return 'time-like';
  if (textual && type !== 'search' && ISO_DATE.test(flowValue)) return 'date text';
  if (type === 'search' || f.role === 'searchbox' || f.role === 'combobox') return 'search';
  if (f.tag === 'textarea' || f.contenteditable) return 'textarea';
  return 'text';
}

const FILLER = '-abcdefghi';

function fillTo(start: string, units: number): string {
  let out = start;
  while (out.length < units) out += FILLER;
  return out.slice(0, units);
}

// Code points, not UTF-16 units: at-limit is exactly L code points.
function fillToCodePoints(start: string, points: number): string | null {
  const have = [...start].length;
  if (have > points) return null;
  let out = start;
  let n = have;
  while (n < points) {
    out += FILLER[(n - have) % FILLER.length];
    n++;
  }
  return out;
}

export function leapYear(today: Date, min: string | null, max: string | null): number {
  const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  let y = today.getUTCFullYear();
  while (!(isLeap(y) && Date.UTC(y, 1, 29) > today.getTime())) y++;
  const maxY = max ? Number(max.slice(0, 4)) : null;
  const minY = min ? Number(min.slice(0, 4)) : null;
  if (maxY !== null && y > maxY) {
    y = maxY;
    while (!isLeap(y)) y--;
  }
  if (minY !== null && y < minY) {
    y = minY;
    while (!isLeap(y)) y++;
  }
  return y;
}

export interface ValueContext {
  v: string;
  unique: string;
  limit: number | null;
  type: string | null;
  today: Date;
  min: string | null;
  max: string | null;
}

// Section 21.5's values, as escape sequences; null when the input doesn't apply.
export function valueFor(id: string, c: ValueContext): string | null {
  switch (id) {
    case 'specials':
      return c.v + ' O\'Brien "x" <b>y</b> 50% a/b#c (d [e \\';
    case 'unicode':
      return '\u{1F469}\u{1F3FD}‍\u{1F4BB} ' + c.v + ' مرحبا ‮x‬​';
    case 'long':
      if (c.type === 'email') {
        const label = fillTo('abcdefghi-'.repeat(7), 60) + 'abc';
        return fillTo(c.unique, 64) + '@' + [label, label, label].join('.') + '.example.com';
      }
      return fillTo(c.v, 10_000);
    case 'at-limit':
      return c.limit === null ? null : fillToCodePoints(c.v, c.limit);
    case 'empty':
      return '';
    case 'spaces':
      return '   ';
    case 'quote-plus':
      return "o'brien+" + c.v;
    case 'no-tld':
      return `${c.unique}@example`;
    case 'huge':
      return '99999999999999999999';
    case 'zero':
      return '0';
    case 'negative':
      return '-1';
    case 'not-a-number':
      return '1,5';
    case 'far-future':
      return c.type === 'datetime-local' || /T/.test(c.v) ? '9999-12-31T23:59' : '9999-12-31';
    case 'leap-day': {
      const y = leapYear(c.today, c.min, c.max);
      return c.type === 'datetime-local' || /T/.test(c.v) ? `${y}-02-29T12:00` : `${y}-02-29`;
    }
    case 'impossible-date': {
      const y = leapYear(c.today, c.min, c.max) - 1;
      return /T/.test(c.v) ? `${y}-02-29T${c.v.split('T')[1]}` : `${y}-02-29`;
    }
    default:
      return null;
  }
}

// Section 21.6's inputs per kind, in rank order.
const INPUTS: Record<FieldKind, string[]> = {
  text: ['empty', 'spaces', 'specials', 'unicode', 'long', 'at-limit'],
  search: ['specials', 'empty', 'unicode', 'long'],
  textarea: ['long', 'empty', 'spaces', 'specials', 'unicode', 'at-limit'],
  email: ['empty', 'long', 'no-tld', 'quote-plus'],
  password: ['long', 'unicode', 'empty'],
  number: ['huge', 'empty', 'zero', 'negative'],
  'numeric text': ['huge', 'not-a-number', 'empty', 'zero', 'negative'],
  date: ['empty', 'far-future', 'leap-day'],
  'date text': ['impossible-date', 'empty', 'far-future'],
  'time-like': ['empty'],
  select: ['placeholder', 'last-option'],
};

// Every bad-input id, for the resilience contract's coverage map (40.7).
export const BAD_INPUT_IDS: string[] = [...new Set(Object.values(INPUTS).flat())];

export function inputsFor(kind: FieldKind, f: FieldFacts, schema: SchemaProp | null): string[] {
  const required = f.required || f.ariaRequired || (schema?.required === true && (schema.minLength ?? 0) >= 1);
  const limit = schema?.maxLength !== undefined && schema.maxLength < 10_000 && !(f.maxlength !== null && f.maxlength <= schema.maxLength) ? schema.maxLength : null;
  return INPUTS[kind].filter((id) => (id !== 'spaces' || required) && (id !== 'at-limit' || limit !== null));
}

// The flag the browser would raise for this value, or null (21.7). Computed from
// the recorded attributes with HTML's validity rules; the value is first cut at
// maxlength in UTF-16 units without splitting a surrogate pair.
export function browserBlock(f: FieldFacts, value: string): string | null {
  let held = value;
  if (f.maxlength !== null && held.length > f.maxlength) {
    let cut = f.maxlength;
    const code = held.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    held = held.slice(0, cut);
  }
  if (f.type === 'email') held = held.trim();
  if (f.required && held === '') return 'valueMissing';
  if (held === '') return null;
  if (f.minlength !== null && held.length < f.minlength) return 'tooShort';
  if (f.type === 'email' && !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(held)) return 'typeMismatch';
  if (f.pattern !== null) {
    try {
      if (!new RegExp(`^(?:${f.pattern})$`, 'v').test(held)) return 'patternMismatch';
    } catch {
      // An invalid pattern never blocks.
    }
  }
  if (f.type === 'number' || f.type === 'date' || f.type === 'datetime-local') {
    const n = f.type === 'number' ? Number(held) : held;
    if (f.min !== null && (f.type === 'number' ? (n as number) < Number(f.min) : (n as string) < f.min)) return 'rangeUnderflow';
    if (f.max !== null && (f.type === 'number' ? (n as number) > Number(f.max) : (n as string) > f.max)) return 'rangeOverflow';
  }
  return null;
}

// `unicode "\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB} Call the plumber 4k..." (61 chars)`.
export function preview(value: string): { text: string; length: number } {
  const escaped = [...value].map((c) => (/^[\x20-\x7e]$/.test(c) ? c : `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`)).join('').replace(/"/g, '\\"');
  return { text: escaped.length > 40 ? escaped.slice(0, 37) + '...' : escaped, length: value.length };
}

// ---- Request evidence and the OpenAPI property.

function leafKeys(value: unknown, prefix: string, out: [string, unknown][]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) return value.forEach((v) => leafKeys(v, prefix, out));
  if (typeof value === 'object') return Object.entries(value).forEach(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k, out));
  out.push([prefix, value]);
}

// The single key whose decoded leaf equals the value: exact, then trimmed and
// case-insensitive, then numbers by value.
export function requestKey(q: RequestRecord, value: string): { key: string; jsonNumber: boolean } | null {
  const pairs: [string, unknown][] = [];
  try {
    new URL(q.url).searchParams.forEach((v, k) => pairs.push([k, v]));
  } catch {
    // No query.
  }
  if (q.postData) {
    try {
      leafKeys(JSON.parse(q.postData), '', pairs);
    } catch {
      new URLSearchParams(q.postData).forEach((v, k) => pairs.push([k, v]));
    }
  }
  const tries = [
    (l: unknown) => String(l) === value,
    (l: unknown) => String(l).trim().toLowerCase() === value.trim().toLowerCase(),
    (l: unknown) => value.trim() !== '' && Number.isFinite(Number(value)) && String(l).trim() !== '' && Number(l) === Number(value),
  ];
  for (const match of tries) {
    const hits = pairs.filter(([, l]) => match(l));
    const keys = [...new Set(hits.map(([k]) => k))];
    if (keys.length === 1) return { key: keys[0]!, jsonNumber: typeof hits[0]![1] === 'number' };
    if (keys.length > 1) return null;
  }
  return null;
}

export function requestSchema(docs: OpenApiDoc[], template: string, key: string): SchemaProp | null {
  const [method, path] = [template.slice(0, template.indexOf(' ')), template.slice(template.indexOf(' ') + 1)];
  for (const d of docs) {
    if (!d.doc.openapi?.startsWith('3.')) continue;
    const op = d.doc.paths?.[path]?.[method.toLowerCase()] as { requestBody?: { content?: Record<string, { schema?: unknown }> } } | undefined;
    const content = op?.requestBody?.content;
    if (!content) continue;
    const resolve = (s: unknown, depth = 0): Record<string, unknown> | null => {
      if (!s || typeof s !== 'object' || depth > 20) return null;
      const ref = (s as { $ref?: string }).$ref;
      if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) return resolve(d.doc.components?.schemas?.[ref.slice(21)], depth + 1);
      return s as Record<string, unknown>;
    };
    const root = resolve((content['application/json'] ?? content['application/x-www-form-urlencoded'] ?? Object.values(content)[0])?.schema);
    let node = root;
    let required = false;
    for (const part of key.split('.')) {
      const props = node?.properties as Record<string, unknown> | undefined;
      required = Array.isArray(node?.required) && (node!.required as string[]).includes(part);
      node = props ? resolve(props[part]) : null;
      if (!node) return null;
    }
    // anyOf [{type: string, maxLength}, {type: null}] as FastAPI writes Optional fields.
    const branch = Array.isArray(node!.anyOf) ? (node!.anyOf as unknown[]).map((b) => resolve(b)).find((b) => b && b.type !== 'null') ?? node : node;
    const pick = { ...node!, ...branch };
    return {
      ...(pick.type !== undefined ? { type: pick.type as string } : {}),
      ...(pick.format !== undefined ? { format: pick.format as string } : {}),
      ...(typeof pick.minLength === 'number' ? { minLength: pick.minLength } : {}),
      ...(typeof pick.maxLength === 'number' ? { maxLength: pick.maxLength } : {}),
      required,
    };
  }
  return null;
}

// ---- Planning one flow's bad inputs.

export interface BadInputPlan {
  inputId: string;
  fillStep: number;
  submitStep: number;
  formSteps: number[];
  value: string;
  select: boolean;
  noOption: boolean;
  carrying: string | null;
  carryingWrite: boolean;
  field: { name: string; kind: FieldKind; key: string | null };
  page: string | null;
  preview: { text: string; length: number };
  limit: number | null;
  // The field's identity across flows (21.1).
  fieldKey: string;
  formName: string;
  diffLinked: boolean;
}

const KIND_ORDER: FieldKind[] = ['number', 'numeric text', 'search', 'password', 'text', 'textarea', 'email', 'date', 'date text', 'time-like', 'select'];
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface PlanResult {
  inputs: BadInputPlan[];
  skipped: string[];
  fieldsNotAttacked: string[];
}

function pageBefore(run: FlowRunResult, step: number): string | null {
  for (let i = step - 1; i >= 1; i--) {
    const p = run.steps.find((s) => s.index === i)?.path;
    if (p) return p;
  }
  return null;
}

// Every runnable input of every form in the flow, in round-robin rank order per form.
export function planBadInputs(flow: Flow, baseline: FlowRunResult, forms: Form[], docs: OpenApiDoc[], options: { signInFlow: boolean; today: Date }): PlanResult {
  const out: PlanResult = { inputs: [], skipped: [], fieldsNotAttacked: [] };
  const returned = new Set<string>();
  for (const form of forms) {
    const submit = flow.steps[form.submitStep - 1];
    const submitKind = submit ? stepKind(submit) : null;
    const submitName = submit && (submitKind === 'click' || submitKind === 'press') ? describeLocator((submit as Record<string, LocatorSpec>)[submitKind]!) : `step ${form.submitStep}`;
    const carryingReq = form.carrying ? baseline.requests.find((q) => q.step === form.submitStep && q.key.replace(/ #\d+$/, '') === form.carrying) ?? null : null;
    const docPost = !form.carrying && baseline.requests.some((q) => q.step === form.submitStep && q.navigation && q.method !== 'GET');
    const carryingWrite = (carryingReq !== null && WRITES.has(carryingReq.method)) || docPost;
    const nativeSubmit = baseline.formEvents.submits.find((e) => e.step === form.submitStep);
    const perField: BadInputPlan[][] = [];
    const page0 = pageBefore(baseline, form.steps[0] ?? form.submitStep) ?? '/';
    for (const index of form.steps) {
      const step = flow.steps[index - 1]!;
      const kind = stepKind(step);
      const spec = (step as Record<string, LocatorSpec>)[kind]!;
      const name = describeLocator(spec);
      const page = pageBefore(baseline, index) ?? '/';
      const notAttacked = (why: string) => out.fieldsNotAttacked.push(`Not attacked: ${name} on ${page} (${why})`);
      if (options.signInFlow) {
        notAttacked('sign-in flow');
        continue;
      }
      if (kind === 'check') {
        notAttacked('checkbox');
        continue;
      }
      const record = baseline.steps.find((s) => s.index === index);
      const facts = record?.field;
      const raw = (step as { value?: string }).value ?? '';
      if (!facts) continue;
      if (['file', 'color', 'range', 'hidden'].includes(facts.type ?? '')) continue;
      if (raw.includes('${env.') || (facts.type === 'password' && flow.signedIn) || facts.autocomplete === 'current-password') {
        notAttacked('credential');
        continue;
      }
      if (carryingReq && ['PUT', 'PATCH', 'DELETE'].includes(carryingReq.method)) {
        for (const q of baseline.requests) {
          if (q.step >= carryingReq.step || q.status === null || q.status >= 300 || q.body === undefined) continue;
          const leaves: [string, unknown][] = [];
          leafKeys(q.body, '', leaves);
          for (const [, l] of leaves) returned.add(String(l));
        }
        let segments: string[] = [];
        try {
          segments = new URL(carryingReq.url).pathname.split('/');
        } catch {
          segments = [];
        }
        if (!segments.some((seg) => seg !== '' && returned.has(seg))) {
          notAttacked('changes a record this flow did not create');
          continue;
        }
      }
      if (facts.readonly || facts.disabled) {
        notAttacked('not editable');
        continue;
      }
      const v = record?.value ?? '';
      const evidence = carryingReq ? requestKey(carryingReq, v) : null;
      const schema = evidence && form.carrying ? requestSchema(docs, form.carrying, evidence.key) : null;
      const fk = fieldKind(facts, { jsonNumber: evidence?.jsonNumber ?? false }, schema, v);
      const limit = schema?.maxLength !== undefined && schema.maxLength < 10_000 && !(facts.maxlength !== null && facts.maxlength <= schema.maxLength) ? schema.maxLength : null;
      const fieldKey = `${page}|${form.carrying ?? 'none'}|${evidence?.key ?? `${name}|${fk}`}`;
      const list: BadInputPlan[] = [];
      for (const inputId of inputsFor(fk, facts, schema)) {
        let value: string | null;
        let noOption = false;
        if (fk === 'select') {
          const options_ = (facts.options ?? []).filter((o) => !o.disabled);
          const chosen = (facts.options ?? []).filter((o) => o.selected).map((o) => o.value);
          if (inputId === 'placeholder') {
            if (facts.multiple) {
              value = '';
              noOption = true;
            } else value = options_.find((o) => o.value === '' && !chosen.includes(o.value))?.value ?? null;
          } else {
            const last = options_.at(-1);
            value = last && !chosen.includes(last.value) ? last.value : null;
          }
        } else {
          value = valueFor(inputId, { v, unique: baseline.unique, limit, type: facts.type, today: options.today, min: facts.min, max: facts.max });
        }
        if (value === null) continue;
        // Inputs the browser is certain to block are skipped (21.7).
        if (fk !== 'select' && nativeSubmit && !nativeSubmit.novalidate && !nativeSubmit.formnovalidate && facts.visible) {
          const flag = browserBlock(facts, value);
          if (flag) {
            out.skipped.push(`Skipped: ${name} on ${page}: ${inputId} (blocked by the browser's validation: ${flag})`);
            continue;
          }
        }
        list.push({
          inputId,
          fillStep: index,
          submitStep: form.submitStep,
          formSteps: form.steps.filter((i) => stepKind(flow.steps[i - 1]!) !== 'check'),
          value,
          select: fk === 'select',
          noOption,
          carrying: form.carrying,
          carryingWrite,
          field: { name, kind: fk, key: evidence?.key ?? null },
          page,
          preview: preview(value),
          limit,
          fieldKey,
          formName: submitName,
          diffLinked: form.diffLinked,
        });
      }
      perField.push(list);
    }
    if (!options.signInFlow && perField.every((l) => l.length === 0) && form.steps.length > 0) {
      out.fieldsNotAttacked.push(`Not attacked: ${submitName} on ${page0} (no attackable field)`);
    }
    // Round-robin by rank; within a round, fields in kind order, then flow order (21.8).
    const ordered = [...perField].filter((l) => l.length > 0).sort((a, b) =>
      KIND_ORDER.indexOf(a[0]!.field.kind) - KIND_ORDER.indexOf(b[0]!.field.kind) || a[0]!.fillStep - b[0]!.fillStep);
    for (let round = 0; ordered.some((l) => l.length > round); round++) {
      for (const l of ordered) if (l[round]) out.inputs.push(l[round]!);
    }
  }
  return out;
}

// Each tier's share: quick the first 3, at most one per field and no selects;
// standard the first 12 (band 1's plus band 2's).
export function tierInputs(inputs: BadInputPlan[], tier: string): { band: 1 | 2; plan: BadInputPlan }[] {
  const band1: BadInputPlan[] = [];
  const fields = new Set<string>();
  for (const p of inputs) {
    if (band1.length >= 3) break;
    if (p.select || fields.has(p.fieldKey)) continue;
    fields.add(p.fieldKey);
    band1.push(p);
  }
  if (tier !== 'standard') return band1.map((plan) => ({ band: 1 as const, plan }));
  const first12 = inputs.slice(0, 12);
  return [...band1.map((plan) => ({ band: 1 as const, plan })), ...first12.filter((p) => !band1.includes(p)).map((plan) => ({ band: 2 as const, plan }))];
}
