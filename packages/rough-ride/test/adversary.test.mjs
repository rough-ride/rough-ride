import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { asciiJson, instructionNotes, linedJson, needsFlowItems, patchRanges, readSpecs } from '../dist/adversary.mjs';
import { checkRootEntry, ensureFolder } from '../dist/folder.mjs';
import { gitBlobs, ReviewedVersions } from '../dist/reviewed.mjs';
import { gitRepo, memoryBlobs, scratchDir, sh } from './helpers.mjs';

const baseAt = (sha) => ({ shown: 'main', ref: 'refs/heads/main', mergeBase: sha, refSha: sha, local: true });
const BASE = 'b'.repeat(40);

// Reviewed versions in memory: merged.txt and edited.txt at the base.
function folderWithSpecs() {
  const root = scratchDir();
  const specs = path.join(root, '.rough-ride', 'specs');
  mkdirSync(specs, { recursive: true });
  writeFileSync(path.join(specs, 'merged.txt'), 'Already merged.\n');
  writeFileSync(path.join(specs, 'edited.txt'), 'After the edit.\r\n');
  writeFileSync(path.join(specs, 'fresh.txt'), '﻿Brand new.\n');
  writeFileSync(path.join(specs, 'notes.md'), '# md\n');
  writeFileSync(path.join(specs, 'wide.txt'), Buffer.from('﻿hi', 'utf16le'));
  const reviewed = new ReviewedVersions(memoryBlobs({ [BASE]: { '.rough-ride/specs/merged.txt': 'Already merged.\n', '.rough-ride/specs/edited.txt': 'Before.\n' } }), baseAt(BASE));
  return { folder: ensureFolder(checkRootEntry(root)), reviewed, specs };
}

test('specs: merged ones are left out; edited and new ones are handed over in name order with their lines; .md and UTF-16 are ignored', () => {
  const { folder, reviewed } = folderWithSpecs();
  const { parts, notes } = readSpecs(folder, reviewed, 'main');
  assert.deepEqual(parts.map((p) => [p.name, p.text]), [['edited.txt', 'After the edit.\n'], ['fresh.txt', 'Brand new.\n']]);
  assert.deepEqual(notes.map((n) => [n.id, n.text]), [
    ['ignored', 'Ignored: .rough-ride/specs/notes.md (rough-ride reads only <name>.txt files)'],
    ['spec', 'Spec: .rough-ride/specs/edited.txt (changed since main, 0.1 KB)'],
    ['spec', 'Spec: .rough-ride/specs/fresh.txt (new since main, 0.1 KB)'],
    ['ignored', 'Ignored: .rough-ride/specs/wide.txt (not UTF-8 text)'],
  ]);
  assert.match(parts[0].sha256, /^[0-9a-f]{64}$/);
});

test('specs: past 32 KB in total the rest are cut; with none, the none line and the hint', () => {
  const { folder, reviewed, specs } = folderWithSpecs();
  writeFileSync(path.join(specs, 'big.txt'), 'x'.repeat(32 * 1024 - 10));
  const { notes } = readSpecs(folder, reviewed, 'main');
  assert.ok(notes.some((n) => n.text === 'Spec cut: .rough-ride/specs/edited.txt (over 32 KB in total)'));
  const empty = scratchDir();
  const none = readSpecs(ensureFolder(checkRootEntry(empty)), new ReviewedVersions(memoryBlobs({}), null), 'origin/main');
  assert.deepEqual(none.notes.map((n) => n.text), [
    'Spec: none (.rough-ride/specs/ has no file that is new or changed since origin/main): only generic checks judge this run.',
    "For app-specific checks, write what you asked for in .rough-ride/specs/<name>.txt yourself (agents can't write there) and run again.",
  ]);
});

// The git adapter's own read: a tree in the batch must not shift the answers after it.
test('specs from git: a name that was a folder at the base reads as new and leaves the later specs in step', () => {
  const root = gitRepo();
  const specs = path.join(root, '.rough-ride', 'specs');
  mkdirSync(path.join(specs, 'aaa.txt'), { recursive: true });
  writeFileSync(path.join(specs, 'aaa.txt', 'inner'), 'x\n');
  writeFileSync(path.join(specs, 'merged.txt'), 'Already merged.\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  const base = sh(root, 'rev-parse', 'HEAD').trim();
  sh(root, 'rm', '-rq', '.rough-ride/specs/aaa.txt');
  writeFileSync(path.join(specs, 'aaa.txt'), 'Now a file.\n');
  const { parts } = readSpecs(ensureFolder(checkRootEntry(root)), new ReviewedVersions(gitBlobs(root), baseAt(base)), 'main');
  assert.deepEqual(parts.map((p) => p.name), ['aaa.txt']);
});

test('instruction files below the root that changed get the line; the root file and deletions do not', () => {
  const files = [{ path: 'frontend/CLAUDE.md', status: 'added' }, { path: 'CLAUDE.md', status: 'modified' }, { path: 'api/AGENTS.md', status: 'deleted' }, { path: 'web/.claude/rules/x.md', status: 'modified' }];
  assert.deepEqual(instructionNotes({ files }, 'origin/main').map((n) => n.text), [
    'Instruction file below the root changed since origin/main: frontend/CLAUDE.md. Claude Code loads it into the adversary when it reads files in frontend/, so its text could steer the adversary.',
    'Instruction file below the root changed since origin/main: web/.claude/rules/x.md. Claude Code loads it into the adversary when it reads files in web/.claude/rules/, so its text could steer the adversary.',
  ]);
});

test('views: patch ranges per file, one array entry per line, ASCII only, needsFlow ids', () => {
  const patch = Buffer.from('diff --git a/a.vue b/a.vue\n@@ -1 +1 @@\n-x\n+y\n# .env.local: modified (contents not shown)\ndiff --git a/b.ts b/b.ts\n+z\n');
  assert.deepEqual([...patchRanges(patch)], [['a.vue', [1, 4]], ['.env.local', [5, 5]], ['b.ts', [6, 7]]]);
  const text = linedJson({ files: [{ path: 'café.vue' }, { path: 'b' }], n: 1 });
  assert.equal(text, '{\n  "files": [\n    {"path":"caf\\u00e9.vue"},\n    {"path":"b"}\n  ],\n  "n": 1\n}\n');
  assert.ok(!/[^\x00-\x7e]/.test(asciiJson('"‮​"')));
  const routes = [{ path: '/tags', component: 'pages/tags.vue', closure: ['pages/tags.vue', 'lib/x.ts'] }, { path: '/notes', component: 'pages/notes.vue', closure: ['lib/x.ts'] }];
  assert.deepEqual(needsFlowItems(routes, ['lib/x.ts', 'pages/tags.vue'], new Set(['lib/x.ts'])), [{ id: 'n1', page: '/tags', file: 'pages/tags.vue', entry: null, source: 'page-trace' }]);
  assert.deepEqual(needsFlowItems(null, ['a'], new Set()), []);
});
