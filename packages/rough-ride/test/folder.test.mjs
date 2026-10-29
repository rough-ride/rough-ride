import assert from 'node:assert/strict';
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { StopError } from '../dist/exit.mjs';
import {
  checkRootEntry,
  ensureFolder,
  folderNotes,
  listYaml,
  locationNotes,
  nestedFoldersNote,
  readFolderFile,
} from '../dist/folder.mjs';
import { caseSensitive, gitRepo, sh } from './helpers.mjs';

const GITIGNORE = '# Written by rough-ride. Keep these lines; add your own below them.\n/.env\n/.env.*\n/runs/\n';

function withFolder() {
  const root = gitRepo();
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  return { root, folder: checkRootEntry(root) };
}

function stopOf(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof StopError) return error.stop;
    throw error;
  }
  assert.fail('expected a stop');
}

test('a link inside the folder stops with folder-shape', () => {
  const { root, folder } = withFolder();
  mkdirSync(path.join(root, 'elsewhere'));
  symlinkSync(path.join(root, 'elsewhere'), path.join(root, '.rough-ride', 'specs'), 'junction');
  const stop = stopOf(() => listYaml(folder, 'specs', []));
  assert.deepEqual([stop.code, stop.lines], [
    'folder-shape',
    ['.rough-ride/specs is a link. rough-ride reads only real files and folders inside .rough-ride/.'],
  ]);
});

test('a hard-linked flow stops with folder-shape', () => {
  const { root, folder } = withFolder();
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'x.yaml'), 'schema: 0.1.0\n');
  linkSync(path.join(root, '.rough-ride', 'flows', 'x.yaml'), path.join(root, 'x-copy.yaml'));
  const stop = stopOf(() => readFolderFile(folder, 'flows', 'x.yaml'));
  assert.deepEqual(stop.lines, ['.rough-ride/flows/x.yaml has another hard link. rough-ride reads only plain files in .rough-ride/.']);
});

test('two flows whose names fold to one stop with folder-shape', () => {
  const { root, folder } = withFolder();
  const flows = path.join(root, '.rough-ride', 'flows');
  writeFileSync(path.join(flows, 'checkout.yaml'), '');
  // Case variants can only coexist on a case-sensitive volume; a trailing dot
  // folds the same way everywhere.
  const other = caseSensitive(flows) ? 'Checkout.yaml' : 'checkout.yaml.';
  writeFileSync(path.join(flows, other), '');
  const stop = stopOf(() => listYaml(folder, 'flows', []));
  assert.equal(stop.code, 'folder-shape');
  const pair = other === 'Checkout.yaml' ? 'Checkout.yaml and checkout.yaml' : 'checkout.yaml and checkout.yaml.';
  assert.equal(stop.lines[0], `.rough-ride/flows holds both ${pair}, which are one file on macOS and Windows. Keep one of them.`);
});

test('.yml files are not read and get their Ignored notes', () => {
  const { root, folder } = withFolder();
  writeFileSync(path.join(root, '.rough-ride', 'config.yml'), 'schema: 0.1.0\n');
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'checkout.yml'), '');
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'sign-in.yaml'), '');
  const notes = [];
  assert.deepEqual(listYaml(folder, 'flows', notes), ['sign-in.yaml']);
  assert.deepEqual(notes, [
    { id: 'ignored', text: 'Ignored: .rough-ride/flows/checkout.yml (rough-ride reads only .yaml files; rename it to checkout.yaml).' },
  ]);
  assert.deepEqual(folderNotes(folder, []).filter((n) => n.id === 'ignored'), [
    { id: 'ignored', text: 'Ignored: .rough-ride/config.yml (rough-ride reads only .yaml files; rename it to config.yaml).' },
  ]);
});

test('a config ignored by a rule outside .rough-ride/.gitignore gets the git-ignored-config note', () => {
  const { root, folder } = withFolder();
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.rough-ride/config.yaml\n');
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), 'schema: 0.1.0\n');
  assert.deepEqual(folderNotes(folder, []).filter((n) => n.id === 'git-ignored-config'), [
    {
      id: 'git-ignored-config',
      text: ".rough-ride/config.yaml is git-ignored (.gitignore:2): it won't reach CI or your team.",
    },
  ]);
});

test('committed run output gets the tracked-run-output note', () => {
  const { root, folder } = withFolder();
  mkdirSync(path.join(root, '.rough-ride', 'runs'));
  writeFileSync(path.join(root, '.rough-ride', 'runs', 'x.json'), '{}');
  sh(root, 'add', '-f', '.rough-ride/runs/x.json');
  assert.deepEqual(folderNotes(folder, []).filter((n) => n.id === 'tracked-run-output'), [
    { id: 'tracked-run-output', text: 'Tracked run output: .rough-ride/runs is committed. Run git rm -r --cached .rough-ride/runs.' },
  ]);
});

test('location notes: root, inside a .rough-ride folder, and long paths on Windows', () => {
  assert.deepEqual(locationNotes('/w/app', '/w/app'), []);
  assert.deepEqual(locationNotes('/w/app', '/w/app/frontend'), [{ id: 'root', text: 'root: /w/app' }]);
  assert.deepEqual(locationNotes('/w/.Rough-Ride/app', '/w/.Rough-Ride/app').map((n) => n.id), ['inside-rough-ride-folder']);
  const long = 'C:/' + 'x'.repeat(140);
  assert.deepEqual(locationNotes(long, long, 'linux'), []);
  assert.deepEqual(locationNotes(long, long, 'win32'), [
    {
      id: 'long-path',
      text: `Long path: run output can reach 264 characters under ${long}, over Windows' 260 limit. Tools without long-path support (Explorer, git without core.longpaths) may fail on it.`,
    },
  ]);
  assert.deepEqual(locationNotes('C:/' + 'x'.repeat(135), 'C:/' + 'x'.repeat(135), 'win32'), []);
});

test('other .rough-ride folders below the root are never read and get one note', () => {
  const { root } = withFolder();
  for (const dir of ['frontend/.rough-ride', 'backend/.Rough-Ride']) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, 'config.yaml'), 'schema: 0.1.0\n');
  }
  assert.deepEqual(nestedFoldersNote(root), {
    id: 'ignored',
    text: 'Ignored: other .rough-ride/ folders (backend/.Rough-Ride/ and 1 more). rough-ride reads only the one at the repository root.',
  });
});

test('a writing invocation creates the folder and the exact .gitignore', () => {
  const root = gitRepo();
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  const folder = ensureFolder(checkRootEntry(root));
  assert.equal(folder.exists, true);
  assert.equal(readFileSync(path.join(root, '.rough-ride', '.gitignore'), 'utf8'), GITIGNORE);
  assert.equal(readFileSync(path.join(root, '.gitignore'), 'utf8'), 'node_modules/\n');
});

test('a complete .gitignore stays byte-identical, CRLF included', () => {
  for (const text of [GITIGNORE.replace(/\n/g, '\r\n'), '/runs/\n.env\n# mine\n*.local\n']) {
    const { root, folder } = withFolder();
    writeFileSync(path.join(root, '.rough-ride', '.gitignore'), text);
    ensureFolder(folder);
    assert.equal(readFileSync(path.join(root, '.rough-ride', '.gitignore'), 'utf8'), text);
  }
});

test('an incomplete .gitignore gets only the missing lines appended, in its own line endings', () => {
  const { root, folder } = withFolder();
  const file = path.join(root, '.rough-ride', '.gitignore');
  writeFileSync(file, '# Written by rough-ride. Keep these lines; add your own below them.\r\n/.env\r\n# ours\r\n*.bak');
  ensureFolder(folder);
  assert.equal(
    readFileSync(file, 'utf8'),
    '# Written by rough-ride. Keep these lines; add your own below them.\r\n/.env\r\n# ours\r\n*.bak\r\n/.env.*\r\n/runs/\r\n',
  );
});
