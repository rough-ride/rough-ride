// The nine network faults as constants of this runner version (spec part 5
// sections 20.1 to 20.15): their bytes, the fault kinds per tier, and the
// empty-200 body rule. No config field or CLI flag changes any of them.

import { createHash } from 'node:crypto';
import type { OpenApiDoc } from './openapi.mjs';

export type FaultId = '500' | '400' | '401' | '429' | 'malformed-json' | 'empty-200' | 'reset' | 'hang' | 'delay-3s';

export const FAULT_IDS: FaultId[] = ['500', '400', '401', '429', 'malformed-json', 'empty-200', 'reset', 'hang', 'delay-3s'];
export const DELAY_MS = 3000;
export const RETRY_AFTER = 1;
export const MAX_BODY = 5 * 1024 * 1024;

// Deadline H: S + 2,000 ms after the attack point's request reached the route.
export function holdMsFor(S: number): number {
  return S + 2000;
}

export interface Fixed {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const envelope = (text: string) => JSON.stringify({ detail: text, message: text, error: text });

// Section 20.5. A cross-origin 429 also exposes retry-after.
export function fixedResponse(fault: '500' | '400' | '401' | '429', crossOrigin: boolean): Fixed {
  switch (fault) {
    case '500':
      return { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Internal Server Error' };
    case '400':
      return { status: 400, headers: { 'content-type': 'application/json' }, body: envelope('Bad Request') };
    case '401':
      return { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }, body: envelope('Not authenticated') };
    case '429':
      return {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(RETRY_AFTER), ...(crossOrigin ? { 'access-control-expose-headers': 'retry-after' } : {}) },
        body: envelope('Too Many Requests'),
      };
  }
}

export function malformedBody(live: string): string {
  return live.trimStart().startsWith('[') ? '[{"id":1,"name":"Unterminated' : '{"id":1,"name":"Unterminated';
}

export function isJsonMedia(media: string | null): boolean {
  return media === 'application/json' || (media !== null && /^application\/[^;]+\+json$/.test(media));
}

export type AppliesTo = 'writes' | 'reads' | 'every' | 'empty-form-gets' | 'json-gets' | 'credentialed';

export interface FaultKind {
  rank: number;
  band: 1 | 2 | 3;
  fault: FaultId;
  sticky: boolean;
  appliesTo: AppliesTo;
  // Whether the sign-in flow gets this kind (never 401).
  signInFlow: boolean;
}

// Section 20.12's table.
export const FAULT_KINDS: FaultKind[] = [
  { rank: 1, band: 1, fault: '500', sticky: true, appliesTo: 'writes', signInFlow: true },
  { rank: 4, band: 1, fault: '500', sticky: true, appliesTo: 'reads', signInFlow: true },
  { rank: 5, band: 1, fault: 'empty-200', sticky: true, appliesTo: 'empty-form-gets', signInFlow: true },
  { rank: 6, band: 1, fault: 'reset', sticky: true, appliesTo: 'writes', signInFlow: true },
  { rank: 9, band: 2, fault: '400', sticky: true, appliesTo: 'every', signInFlow: true },
  { rank: 10, band: 2, fault: 'reset', sticky: true, appliesTo: 'reads', signInFlow: true },
  { rank: 12, band: 2, fault: '401', sticky: true, appliesTo: 'credentialed', signInFlow: false },
  { rank: 13, band: 2, fault: '429', sticky: true, appliesTo: 'every', signInFlow: true },
  { rank: 16, band: 3, fault: 'malformed-json', sticky: true, appliesTo: 'json-gets', signInFlow: true },
  { rank: 17, band: 3, fault: '500', sticky: false, appliesTo: 'reads', signInFlow: true },
  { rank: 18, band: 3, fault: 'delay-3s', sticky: false, appliesTo: 'every', signInFlow: true },
  { rank: 20, band: 3, fault: 'hang', sticky: true, appliesTo: 'every', signInFlow: true },
];

export const TIER_BANDS: Record<string, number[]> = { quick: [1], standard: [1, 2, 3] };

export function kindsFor(tier: string): FaultKind[] {
  const bands = TIER_BANDS[tier] ?? TIER_BANDS.quick!;
  return FAULT_KINDS.filter((k) => bands.includes(k.band));
}

// Section 37's fixed phrases; a hang names itself only once the page gave up.
export const FAULT_PHRASE: Record<FaultId, string> = {
  '500': 'fails with 500',
  '400': 'fails with 400',
  '401': 'answers 401 (signed out)',
  '429': 'is rate limited (429)',
  reset: 'loses its connection',
  hang: 'times out',
  'delay-3s': 'is slow (3 s)',
  'malformed-json': 'returns malformed JSON',
  'empty-200': 'returns empty data',
};

export function attackId(flow: string, key: string, fault: FaultId, sticky: boolean): string {
  return `${flow}/${key}/${fault}${sticky ? '!' : ''}`;
}

// ---- OpenAPI schemas, read only for minItems, tuples and nullability (20.7).

type Schema = Record<string, unknown>;

export function responseSchema(docs: OpenApiDoc[], method: string, template: string): { schema: Schema | null; doc: OpenApiDoc | null } {
  const path = template.slice(template.indexOf(' ') + 1);
  for (const d of docs) {
    const op = d.doc.paths?.[path]?.[method.toLowerCase()] as { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> } | undefined;
    if (!op?.responses) continue;
    const code = Object.keys(op.responses).sort().find((c) => /^2(\d\d|XX)$/i.test(c));
    const content = code ? op.responses[code]?.content : undefined;
    const schema = content?.['application/json']?.schema ?? null;
    return { schema, doc: d };
  }
  return { schema: null, doc: null };
}

function resolve(schema: unknown, doc: OpenApiDoc | null, depth = 0): Schema | null {
  if (!schema || typeof schema !== 'object' || depth > 20) return null;
  const s = schema as Schema;
  const ref = s.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/components/schemas/') && doc) {
    return resolve(doc.doc.components?.schemas?.[ref.slice('#/components/schemas/'.length)], doc, depth + 1);
  }
  // allOf: merge the branches' properties, keeping the first minItems.
  if (Array.isArray(s.allOf)) {
    const merged: Schema = { ...s, properties: { ...((s.properties as Schema) ?? {}) } };
    for (const branch of s.allOf) {
      const r = resolve(branch, doc, depth + 1);
      if (!r) continue;
      Object.assign(merged.properties as Schema, (r.properties as Schema) ?? {});
      for (const key of ['minItems', 'nullable', 'type', 'prefixItems', 'items']) if (merged[key] === undefined && r[key] !== undefined) merged[key] = r[key];
    }
    return merged;
  }
  return s;
}

function minItemsAtLeastOne(s: Schema | null): boolean {
  return typeof s?.minItems === 'number' && s.minItems >= 1;
}

function isTuple(s: Schema | null): boolean {
  return Array.isArray(s?.prefixItems) || Array.isArray(s?.items);
}

function allowsNull(s: Schema | null, doc: OpenApiDoc | null): boolean {
  if (!s) return false;
  if (s.nullable === true) return true;
  if (s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null'))) return true;
  for (const key of ['anyOf', 'oneOf']) {
    const list = s[key];
    if (Array.isArray(list) && list.some((b) => {
      const r = resolve(b, doc);
      return r !== null && (r.type === 'null' || (Array.isArray(r.type) && r.type.includes('null')));
    })) return true;
  }
  return false;
}

function propertySchema(s: Schema | null, key: string, doc: OpenApiDoc | null): Schema | null {
  const props = s?.properties as Schema | undefined;
  return props ? resolve(props[key], doc) : null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export type BodyKind = '[]' | 'arrays-emptied' | 'null';

// Section 20.7: the first matching rule picks the body. Null when no rule applies.
export function emptyForm(live: unknown, template: string, schemaIn: Schema | null, doc: OpenApiDoc | null): { kind: BodyKind; body: string } | null {
  const schema = resolve(schemaIn, doc);
  if (Array.isArray(live) && !minItemsAtLeastOne(schema)) return { kind: '[]', body: '[]' };
  const last = template.split('/').at(-1) ?? '';
  const literalEnd = last !== '' && !/^\{[^}]*\}(\.[^/]*)?$/.test(last);
  if (isPlainObject(live) && literalEnd) {
    let emptied = 0;
    // Arrays of objects that sit inside no other array; arrays are never descended.
    const walk = (value: Record<string, unknown>, s: Schema | null): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        const child = propertySchema(s, key, doc);
        if (Array.isArray(v)) {
          const ofObjects = v.length > 0 && v.every(isPlainObject);
          if (ofObjects && !minItemsAtLeastOne(child) && !isTuple(child)) {
            emptied++;
            out[key] = [];
          } else out[key] = v;
        } else if (isPlainObject(v)) out[key] = walk(v, child);
        else out[key] = v;
      }
      return out;
    };
    const result = walk(live, schema);
    if (emptied > 0) return { kind: 'arrays-emptied', body: JSON.stringify(result) };
  }
  if (allowsNull(schema, doc)) return { kind: 'null', body: 'null' };
  return null;
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
