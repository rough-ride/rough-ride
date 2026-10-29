// The runner's own JSON Schema validator for exactly the keywords part 2
// section 7.9 allows. No ajv: every runtime dependency must have none of its own.

import { readFileSync } from 'node:fs';

export const ALLOWED_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'default', 'type', 'properties', 'required',
  'additionalProperties', 'items', 'enum', 'const', 'pattern', 'oneOf', 'minimum',
]);

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  // false everywhere, except a map such as plan.json's flows, which gives
  // the schema of every value.
  additionalProperties?: false | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  oneOf?: JsonSchema[];
  minimum?: number;
}

export type SchemaErrorKind = 'unknown-field' | 'missing' | 'wrong-type' | 'invalid';

export interface SchemaError {
  path: (string | number)[];
  kind: SchemaErrorKind;
  // For wrong-type and invalid: what was expected, in words.
  expected?: string;
}

export function loadSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(new URL(`./schemas/${name}`, import.meta.url), 'utf8')) as JsonSchema;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(type: string, value: unknown): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

const TYPE_WORDS: Record<string, string> = {
  string: 'text',
  integer: 'a whole number',
  number: 'a number',
  boolean: 'true or false',
  object: 'a mapping',
  array: 'a list',
  null: 'empty',
};

export function describe(schema: JsonSchema): string {
  if (schema.enum) return `one of ${schema.enum.map(String).join(', ')}`;
  if (schema.const !== undefined) return String(schema.const);
  if (schema.oneOf) return schema.oneOf.map(describe).join(' or ');
  if (schema.type === 'array' && schema.items?.type) return `a list of ${TYPE_WORDS[schema.items.type] ?? schema.items.type}`;
  return TYPE_WORDS[schema.type ?? ''] ?? 'a valid value';
}

export function validate(schema: JsonSchema, value: unknown, at: (string | number)[] = []): SchemaError[] {
  if (schema.oneOf) {
    const fits = schema.oneOf.filter((option) => validate(option, value, at).length === 0);
    return fits.length === 1 ? [] : [{ path: at, kind: 'wrong-type', expected: describe(schema) }];
  }
  if (schema.type && !typeMatches(schema.type, value)) return [{ path: at, kind: 'wrong-type', expected: describe(schema) }];
  if (schema.enum && !schema.enum.includes(value)) return [{ path: at, kind: 'invalid', expected: describe(schema) }];
  if (schema.const !== undefined && value !== schema.const) return [{ path: at, kind: 'invalid', expected: describe(schema) }];
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
    return [{ path: at, kind: 'invalid', expected: `text matching ${schema.pattern}` }];
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    return [{ path: at, kind: 'invalid', expected: `${schema.minimum} or more` }];
  }
  const errors: SchemaError[] = [];
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items!, item, [...at, i])));
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push({ path: [...at, key], kind: 'missing' });
    }
    for (const [key, child] of Object.entries(object)) {
      const sub = schema.properties?.[key];
      const extra = schema.additionalProperties;
      if (sub) errors.push(...validate(sub, child, [...at, key]));
      else if (extra === false) errors.push({ path: [...at, key], kind: 'unknown-field' });
      else if (extra) errors.push(...validate(extra, child, [...at, key]));
    }
  }
  return errors;
}
