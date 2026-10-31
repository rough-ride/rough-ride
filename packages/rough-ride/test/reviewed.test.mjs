import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gitBlobs, memoryBlobs, normalisedText, ReviewedVersions } from '../dist/reviewed.mjs';
import { gitRepo, sh } from './helpers.mjs';

const baseOf = (mergeBase, refSha) => ({ shown: 'origin/main', ref: 'refs/remotes/origin/main', mergeBase, refSha, local: false });

// A merge base and a later base-ref commit: a.yaml changes, b.yaml becomes a folder, c.yaml is added.
function twoCommits() {
  const root = gitRepo();
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  write('.rough-ride/a.yaml', 'a: 1\n');
  write('.rough-ride/b.yaml', 'b: 1\n');
  write('.rough-ride/z.yaml', 'z: 1\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'one');
  const merge = sh(root, 'rev-parse', 'HEAD').trim();
  write('.rough-ride/a.yaml', 'a: 2\n');
  sh(root, 'rm', '-q', '.rough-ride/b.yaml');
  write('.rough-ride/b.yaml/inner', 'x\n');
  write('.rough-ride/c.yaml', 'c: 1\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'two');
  const ref = sh(root, 'rev-parse', 'HEAD').trim();
  const memory = memoryBlobs({
    [merge]: { '.rough-ride/a.yaml': 'a: 1\n', '.rough-ride/b.yaml': 'b: 1\n', '.rough-ride/z.yaml': 'z: 1\n' },
    [ref]: { '.rough-ride/a.yaml': 'a: 2\n', '.rough-ride/b.yaml/inner': 'x\n', '.rough-ride/c.yaml': 'c: 1\n', '.rough-ride/z.yaml': 'z: 1\n' },
  });
  return { root, merge, ref, memory };
}

const view = (reviewed) => ({
  listed: reviewed.list('.rough-ride'),
  texts: Object.fromEntries(['a', 'b', 'c', 'z', 'gone'].map((n) => [n, reviewed.bytes(`.rough-ride/${n}.yaml`).map((b) => b?.toString('utf8') ?? null)])),
});

test('git and the in-memory adapter give the same reviewed versions: both commits, absent paths and a folder at a file name read null', () => {
  const { root, merge, ref, memory } = twoCommits();
  const fromGit = view(new ReviewedVersions(gitBlobs(root), baseOf(merge, ref)));
  assert.deepEqual(fromGit, {
    listed: ['.rough-ride/a.yaml', '.rough-ride/b.yaml', '.rough-ride/b.yaml/inner', '.rough-ride/c.yaml', '.rough-ride/z.yaml'],
    texts: { a: ['a: 1\n', 'a: 2\n'], b: ['b: 1\n', null], c: [null, 'c: 1\n'], z: ['z: 1\n', 'z: 1\n'], gone: [null, null] },
  });
  assert.deepEqual(view(new ReviewedVersions(memory, baseOf(merge, ref))), fromGit);
});

test('paths asked for before the first read share one batch; the base ref\'s commit is read once when it is the merge base', () => {
  const { merge, memory } = twoCommits();
  const calls = [];
  const counted = { ...memory, read: (specs) => (calls.push(specs), memory.read(specs)) };
  const reviewed = new ReviewedVersions(counted, baseOf(merge, merge));
  assert.deepEqual(reviewed.commits, [merge]);
  reviewed.want(['.rough-ride/a.yaml', 'CLAUDE.md']);
  reviewed.want(['.rough-ride/z.yaml']);
  assert.deepEqual(reviewed.texts('.rough-ride/a.yaml'), ['a: 1\n']);
  assert.deepEqual(reviewed.atMergeBase(['CLAUDE.md']), new Map([['CLAUDE.md', null]]));
  assert.deepEqual(reviewed.texts('.rough-ride/z.yaml'), ['z: 1\n']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [`${merge}:.rough-ride/a.yaml`, `${merge}:.rough-ride/z.yaml`, `${merge}:CLAUDE.md`].sort());
});

test('no base: nothing is listed or read, and the merge-base view is null', () => {
  const reviewed = new ReviewedVersions(memoryBlobs({}), null);
  assert.deepEqual(reviewed.list('.rough-ride'), []);
  assert.deepEqual(reviewed.bytes('.rough-ride/a.yaml'), []);
  assert.equal(reviewed.atMergeBase(['CLAUDE.md']), null);
  assert.equal(reviewed.lastMove(), null);
});

test('one normalisation: a leading BOM and CRLF never count', () => {
  assert.equal(normalisedText('﻿a: 1\r\nb: 2\r\n'), 'a: 1\nb: 2\n');
  assert.equal(normalisedText('a﻿\r'), 'a﻿\r');
});
