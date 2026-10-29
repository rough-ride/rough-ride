import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.mjs';
import { StopError } from '../dist/exit.mjs';
import { checkRootEntry } from '../dist/folder.mjs';
import { ALLOWED_KEYWORDS } from '../dist/schema.mjs';
import { gitRepo } from './helpers.mjs';

function load(text) {
  const root = gitRepo();
  mkdirSync(path.join(root, '.rough-ride'));
  const file = path.join(root, '.rough-ride', 'config.yaml');
  writeFileSync(file, text);
  const before = readFileSync(file);
  try {
    return { config: loadConfig(checkRootEntry(root)) };
  } catch (error) {
    if (error instanceof StopError) return { stop: error.stop };
    throw error;
  } finally {
    assert.deepEqual(readFileSync(file), before, 'config.yaml bytes changed');
  }
}

const FULL = `# yaml-language-server: $schema=https://raw.githubusercontent.com/rough-ride/rough-ride/v0.1.0/packages/rough-ride/src/schemas/config.schema.json
schema: 0.1.0
target:
  url: http://localhost:3000
  start: [npm run dev, npm run api]
  startTimeout: 120
  ready: "window.appReady === true"
reset: npm run db:reset
browser: chrome
exclude:
  - /admin/**
allow:
  remoteTarget: staging.example.com
  remoteWrites:
    - abcd1234.supabase.co
`;

test('a full config loads', () => {
  const { config } = load(FULL);
  assert.equal(config.schema, '0.1.0');
  assert.deepEqual(config.target.start, ['npm run dev', 'npm run api']);
  assert.deepEqual(config.allow.remoteWrites, ['abcd1234.supabase.co']);
});

test('a BOM and CRLF load; an empty or comment-only file is no config', () => {
  assert.deepEqual(load('\ufeffschema: "0.1.0"\r\nreset: npm run db:reset\r\n').config, {
    schema: '0.1.0',
    reset: 'npm run db:reset',
  });
  assert.equal(load('').config, null);
  assert.equal(load('# nothing yet\n\n# really\n').config, null);
});

const CASES = [
  ['%YAML 1.1\n---\nschema: 0.1.0\n', '.rough-ride/config.yaml line 1: %YAML 1.1 directive; rough-ride reads YAML 1.2 only.'],
  ['schema: 0.1.0\nreset: a\nreset: b\n', '.rough-ride/config.yaml line 3: reset appears twice in the same mapping.'],
  ['schema: 0.1.0\n---\nreset: b\n', '.rough-ride/config.yaml line 2: a second YAML document; rough-ride reads one document per file.'],
  [
    'reset: npm run db:reset\n',
    '.rough-ride/config.yaml has no schema line. Add "schema: 0.1.0" as its first line: the config format rough-ride 0.1.0 reads.',
  ],
  [
    'schema: 0.10\n',
    '.rough-ride/config.yaml line 1: schema must be a rough-ride version with three parts, such as 0.1.0 (found 0.10).',
  ],
  ['schema: 0.1.0\ntarget:\n  port: 3000\n', '.rough-ride/config.yaml line 3: target.port is not a field rough-ride reads here.'],
  ['$schema: x\nschema: 0.1.0\n', '.rough-ride/config.yaml line 1: $schema is not a field rough-ride reads here.'],
  ['schema: 0.1.0\nbrowser: firefox\n', '.rough-ride/config.yaml line 2: browser must be one of chrome, msedge, chromium.'],
  ['schema: 0.1.0\ntarget:\n  startTimeout: soon\n', '.rough-ride/config.yaml line 3: target.startTimeout must be a whole number.'],
  ['schema: 0.1.0\nexclude: /admin/**\n', '.rough-ride/config.yaml line 2: exclude must be a list of text.'],
  ['- schema: 0.1.0\n', '.rough-ride/config.yaml: the top level must be a mapping (key: value lines).'],
];

for (const [text, line] of CASES) {
  test(`stops with exit 78: ${JSON.stringify(text).slice(0, 50)}`, () => {
    const { stop } = load(text);
    assert.ok(stop, 'expected a stop');
    assert.deepEqual([stop.kind, stop.code, stop.lines], ['setup', 'files-invalid', [line]]);
  });
}

test('the schema files use only the allowed keywords and close every object', () => {
  const dir = fileURLToPath(new URL('../dist/schemas/', import.meta.url));
  for (const name of readdirSync(dir)) {
    const walk = (schema, at) => {
      for (const key of Object.keys(schema)) assert.ok(ALLOWED_KEYWORDS.has(key), `${name} ${at}: ${key}`);
      if (schema.type === 'object') {
        const extra = schema.additionalProperties;
        // A map (no properties) gives the schema of its values; every other object is closed.
        if (schema.properties) assert.equal(extra, false, `${name} ${at}`);
        else assert.equal(typeof extra, 'object', `${name} ${at}`);
      }
      if (typeof schema.additionalProperties === 'object') walk(schema.additionalProperties, `${at}{}`);
      for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, `${at}.${key}`);
      if (schema.items) walk(schema.items, `${at}[]`);
      (schema.oneOf ?? []).forEach((child, i) => walk(child, `${at}|${i}`));
    };
    const schema = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    walk(schema, '');
    assert.ok(schema.required.includes('schema'), name);
    assert.equal(schema.properties.schema.pattern, '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$');
  }
});
