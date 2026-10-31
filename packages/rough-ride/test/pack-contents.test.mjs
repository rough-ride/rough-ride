import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packProblems } from '../../../scripts/pack-contents.mjs';
import { scratchDir } from './helpers.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const good = { files: [{ path: 'package.json' }, { path: 'README.md' }, { path: 'LICENSE' }, { path: 'npm-shrinkwrap.json' }, { path: 'dist/cli.mjs' }], unpackedSize: 50_000 };

// A copy of the package's own metadata to break on purpose.
function pkg() {
  const dir = scratchDir();
  for (const f of ['package.json', 'npm-shrinkwrap.json', 'package-lock.json', 'LICENSE', 'README.md']) cpSync(path.join(PKG, f), path.join(dir, f));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'cli.mts'), '');
  return dir;
}

test('the real package metadata passes', () => {
  assert.deepEqual(packProblems(pkg(), good, ROOT), []);
});

test('pack-contents fails each listed case', () => {
  const dir = pkg();
  const expect = (pack, pattern, d = dir) => assert.ok(packProblems(d, pack, ROOT).some((p) => pattern.test(p)), String(pattern));
  expect({ ...good, files: [...good.files, { path: 'benchmark/apps/fixture/app.yaml' }] }, /outside the files allowlist: benchmark\//);
  expect({ ...good, files: [...good.files, { path: 'dist/cli.mjs.map' }] }, /outside the files allowlist: dist\/cli\.mjs\.map/);
  expect({ ...good, unpackedSize: 3 * 1024 * 1024 }, /over 2 MB/);
  expect({ ...good, files: [...good.files, { path: `templates/${'x'.repeat(120)}` }] }, /longer than 120 characters/);
  expect({ ...good, files: [...good.files, { path: 'dist/orphan.mjs' }] }, /dist\/orphan\.mjs has no matching src\/orphan\.mts/);

  const bundled = pkg();
  const meta = JSON.parse(JSON.stringify(require_(path.join(bundled, 'package.json'))));
  writeFileSync(path.join(bundled, 'package.json'), JSON.stringify({ ...meta, bundleDependencies: ['yaml'] }));
  expect(good, /bundleDependencies is set/, bundled);

  const drift = pkg();
  writeFileSync(path.join(drift, 'package.json'), JSON.stringify({ ...meta, dependencies: { ...meta.dependencies, yaml: '2.9.0' } }));
  expect(good, /npm-shrinkwrap\.json lists .* but package\.json lists/, drift);

  const lock = pkg();
  writeFileSync(path.join(lock, 'package-lock.json'), '{}');
  expect(good, /package-lock\.json differs from npm-shrinkwrap\.json/, lock);

  const licence = pkg();
  writeFileSync(path.join(licence, 'LICENSE'), 'changed');
  expect(good, /LICENSE differs from the root LICENSE/, licence);

  const gpl = pkg();
  const shrink = require_(path.join(gpl, 'npm-shrinkwrap.json'));
  shrink.packages['node_modules/yaml'].license = 'GPL-3.0';
  writeFileSync(path.join(gpl, 'npm-shrinkwrap.json'), JSON.stringify(shrink));
  expect(good, /node_modules\/yaml has licence GPL-3\.0, outside the allowed list/, gpl);
});

function require_(file) {
  return JSON.parse(readText(file));
}

import { readFileSync } from 'node:fs';
function readText(file) {
  return readFileSync(file, 'utf8');
}
