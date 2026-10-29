// Forms, submit steps and carrying requests (spec part 5 section 21.2), and the
// order of reached flows (part 4 section 17.6).

import { isFrameworkInternal, stepKind, type Flow, type FlowRunResult } from './flowrun.mjs';

export interface Form {
  // 1-based indexes of the attackable steps that share one submit step.
  steps: number[];
  submitStep: number;
  // `METHOD template` of the baseline request that carried the values, or null.
  carrying: string | null;
  diffLinked: boolean;
}

function leaves(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) return value.forEach((v) => leaves(v, out));
  if (typeof value === 'object') return Object.values(value).forEach((v) => leaves(v, out));
  out.push(String(value));
}

// Decoded leaf values of a request: JSON body, urlencoded body or query string.
export function requestLeaves(url: string, postData: string | null): string[] {
  const out: string[] = [];
  try {
    new URL(url).searchParams.forEach((v) => out.push(v));
  } catch {
    // No query to read.
  }
  if (postData) {
    try {
      leaves(JSON.parse(postData), out);
    } catch {
      try {
        new URLSearchParams(postData).forEach((v) => out.push(v));
      } catch {
        // A body that is neither JSON nor urlencoded.
      }
    }
  }
  return out;
}

// Exact, then trimmed and case-insensitive, then numbers by value.
export function carries(leavesOf: string[], value: string): boolean {
  if (leavesOf.includes(value)) return true;
  const norm = value.trim().toLowerCase();
  if (leavesOf.some((l) => l.trim().toLowerCase() === norm)) return true;
  const n = Number(value);
  return value.trim() !== '' && Number.isFinite(n) && leavesOf.some((l) => l.trim() !== '' && Number(l) === n);
}

export function findForms(flow: Flow, run: FlowRunResult, ownHost: (url: string) => boolean, changedEndpoints: Set<string>): Form[] {
  const bySubmit = new Map<number, Form>();
  const steps = flow.steps;
  for (const step of run.steps) {
    if (step.value === undefined) continue;
    const kind = stepKind(steps[step.index - 1]!);
    if (kind !== 'fill' && kind !== 'select' && kind !== 'check') continue;
    // The first own-origin request at or after the field's step that carried its value.
    const carrying = run.requests.find((q) =>
      q.step >= step.index && (q.resourceType === 'fetch' || q.resourceType === 'xhr') && ownHost(q.url) && !isFrameworkInternal(q.url) &&
      carries(requestLeaves(q.url, q.postData), step.value!));
    let submit: number;
    if (carrying) submit = carrying.step;
    else {
      const next = steps.findIndex((s, i) => i >= step.index && (stepKind(s) === 'click' || stepKind(s) === 'press'));
      submit = next === -1 ? step.index : next + 1;
    }
    const template = carrying ? carrying.key.replace(/ #\d+$/, '') : null;
    const form = bySubmit.get(submit) ?? { steps: [], submitStep: submit, carrying: template, diffLinked: false };
    form.steps.push(step.index);
    if (!form.carrying && template) form.carrying = template;
    form.diffLinked = form.carrying !== null && changedEndpoints.has(form.carrying);
    bySubmit.set(submit, form);
  }
  return [...bySubmit.values()].sort((a, b) => a.submitStep - b.submitStep);
}

export type FlowClass = 'form' | 'write' | 'read' | 'module' | 'app-wide';
const CLASS_ORDER: FlowClass[] = ['form', 'write', 'read', 'module', 'app-wide'];
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function flowClass(input: { forms: Form[]; requestKeys: string[]; changedEndpoints: Set<string>; reachesByRule: boolean }): FlowClass | null {
  if (input.forms.some((f) => f.diffLinked)) return 'form';
  const hits = input.requestKeys.map((k) => k.replace(/ #\d+$/, '')).filter((k) => input.changedEndpoints.has(k));
  if (hits.some((k) => WRITES.has(k.split(' ')[0]!))) return 'write';
  if (hits.length > 0) return 'read';
  return input.reachesByRule ? 'module' : null;
}

export interface Ordered {
  name: string;
  cls: FlowClass;
  reachCount: number;
}

// By class, then more changed files and endpoints reached, then file name by
// code point; the sign-in flow last.
export function orderFlows(flows: Ordered[]): Ordered[] {
  return [...flows].sort((a, b) => {
    if ((a.name === 'sign-in') !== (b.name === 'sign-in')) return a.name === 'sign-in' ? 1 : -1;
    const c = CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls);
    if (c !== 0) return c;
    if (a.reachCount !== b.reachCount) return b.reachCount - a.reachCount;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
