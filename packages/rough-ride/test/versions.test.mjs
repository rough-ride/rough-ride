import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setVersion, syncProblems, versionsIn } from '../../../scripts/versions.mjs';
import { scratchDir } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// The files that carry the version, copied to a scratch root.
function tree() {
  const root = scratchDir();
  const pkg = path.join(root, 'packages', 'rough-ride');
  mkdirSync(path.join(pkg, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  for (const f of ['package.json', 'npm-shrinkwrap.json', '.claude-plugin/plugin.json']) cpSync(path.join(ROOT, 'packages', 'rough-ride', f), path.join(pkg, f));
  cpSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), path.join(root, '.claude-plugin', 'marketplace.json'));
  writeFileSync(path.join(root, 'README.md'), 'Run `npx -y rough-ride@0.1.0 quick` or `npx --no rough-ride quick`.\n');
  return root;
}

test('the repository\'s versions agree today', () => {
  assert.deepEqual(syncProblems(versionsIn(ROOT)), []);
});

test('version:set rewrites package.json, plugin.json, the shrinkwrap root and pinned examples, never the marketplace entry', () => {
  const root = tree();
  const marketplace = readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8');
  setVersion('0.2.0', root);
  assert.deepEqual([...new Set(versionsIn(root).map((f) => f.value))], ['0.2.0']);
  assert.match(readFileSync(path.join(root, 'README.md'), 'utf8'), /rough-ride@0\.2\.0 quick/);
  assert.equal(readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'), marketplace);
  const pkgDir = path.join(root, 'packages', 'rough-ride');
  assert.equal(readFileSync(path.join(pkgDir, 'package-lock.json'), 'utf8'), readFileSync(path.join(pkgDir, 'npm-shrinkwrap.json'), 'utf8'));
  assert.throws(() => setVersion('v0.3', root), /not x\.y\.z/);
});

test('version-sync fails a plugin.json that differs and a tag whose files say another version', () => {
  const root = tree();
  const plugin = path.join(root, 'packages', 'rough-ride', '.claude-plugin', 'plugin.json');
  writeFileSync(plugin, JSON.stringify({ ...JSON.parse(readFileSync(plugin, 'utf8')), version: '0.1.1' }));
  assert.match(syncProblems(versionsIn(root)).join('\n'), /plugin\.json says 0\.1\.1, packages\/rough-ride\/package\.json says 0\.1\.0/);
  setVersion('0.4.9', root);
  assert.deepEqual(syncProblems(versionsIn(root)), []);
  assert.match(syncProblems(versionsIn(root), 'v0.5.0').join('\n'), /says 0\.4\.9, the tag v0\.5\.0 says 0\.5\.0/);
  assert.deepEqual(syncProblems(versionsIn(root), 'v0.4.9'), []);
  assert.deepEqual(syncProblems(versionsIn(root), 'v0.4.9-rc.2'), []);
});

import { entryProblems } from '../../../scripts/marketplace-entry.mjs';

test('marketplace-entry fails a range, a dist-tag and a missing value', () => {
  const entry = (source) => ({ plugins: [{ name: 'rough-ride', source: { source: 'npm', package: 'rough-ride', ...source } }] });
  assert.deepEqual(entryProblems(entry({ version: '0.1.0' })), []);
  assert.match(entryProblems(entry({ version: '^0.1.0' }))[0], /not an exact x\.y\.z/);
  assert.match(entryProblems(entry({ version: 'latest' }))[0], /not an exact x\.y\.z/);
  assert.match(entryProblems(entry({}))[0], /source\.version is missing/);
  assert.deepEqual(entryProblems({ plugins: [] }), ['no rough-ride entry in .claude-plugin/marketplace.json']);
});
