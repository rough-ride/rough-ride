// Regression tests (spec part 6 section 24, ADR 0003): YAML data naming a saved
// flow, one attack and the checks the finding failed. Every finding gets a
// candidate in run output; a confirmed shown finding gets a committed test,
// written once and never rewritten.

import { createHash } from 'node:crypto';
import { Document, isMap, isSeq } from 'yaml';
import type { AttackOutcome } from './attacks.mjs';
import { FORMATS } from './formats.mjs';
import { canonicalJson } from './output.mjs';
import { attackKey, context } from './record.mjs';

export interface RegressionTest {
  name: string;
  value: Record<string, unknown>;
  text: string;
}

function slug(o: AttackOutcome): string {
  if (o.kind === 'viewport') return 'viewport-375';
  if (o.kind === 'bad-input' && o.badInput) return o.badInput.inputId;
  if (o.kind === 'timing' && o.timing) return o.timing;
  return o.fault ?? 'attack';
}

// `<flow>-<attack slug>-<6 hex>`, the flow part shortened to the 48-character name rule (24.3).
export function testName(flow: string, o: AttackOutcome): string {
  const hex = createHash('sha256').update(canonicalJson({ flow, attack: attackKey(o) })).digest('hex').slice(0, 6);
  const tail = `-${slug(o)}-${hex}`;
  const head = flow.slice(0, Math.max(1, 48 - tail.length)).replace(/-+$/, '');
  return `${head}${tail}`;
}

// The YAML bytes: keys in order, LF, a final newline, no BOM; nested values in flow style.
export function renderTest(value: Record<string, unknown>): string {
  const doc = new Document(value);
  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      const v = pair.value;
      if (isMap(v) || isSeq(v)) v.flow = true;
    }
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\r\n/g, '\n');
}

export function buildTest(o: AttackOutcome, checks: string[], meta: { finding: string; run: string; runner: string; date: string }): RegressionTest {
  const found: Record<string, unknown> = { finding: meta.finding, run: meta.run, runner: meta.runner, date: meta.date };
  if (o.kind === 'bad-input' && o.badInput) {
    const held = o.run.badInput?.held ?? null;
    found.held = {
      length: held?.length ?? null,
      preview: `${o.badInput.inputId} "${o.badInput.preview.text}" (${o.badInput.preview.length} chars)`,
      cutBy: held !== null && held.length < o.badInput.value.length ? 'maxlength' : null,
    };
  }
  if (o.fault === 'empty-200' && o.served && 'bodyKind' in o.served) found.bodyKind = o.served.bodyKind;
  const value = {
    schema: FORMATS.tests.current,
    flow: o.flow,
    attack: attackKey(o),
    // A failed app-specific check goes in inline, as 45.9 keeps it.
    checks: checks.map((id) => o.checks?.find((c) => c.id === id)?.app?.inline ?? id),
    context: context(),
    found,
  };
  return { name: testName(o.flow, o), value, text: renderTest(value) };
}
