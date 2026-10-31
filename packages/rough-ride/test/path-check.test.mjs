// The table-driven test of the shared path module (spec part 2 section 6
// Acceptance). Rows that need one OS run only there and say why elsewhere.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canon, checkPath, couldBeInside, fold, inside, printed, samePath } from '../hooks/path-check.mjs';
import { StopError } from '../dist/exit.mjs';
import { checkRootEntry, readFolderFile } from '../dist/folder.mjs';
import { caseSensitive, gitRepo, scratchDir } from './helpers.mjs';

const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const onlyWindows = { skip: !win && 'Windows path forms' };
const onlyMac = { skip: !mac && 'macOS path spellings' };

function tree() {
  const dir = scratchDir();
  mkdirSync(path.join(dir, '.rough-ride', 'flows'), { recursive: true });
  writeFileSync(path.join(dir, '.rough-ride', 'flows', 'x.yaml'), 'schema: 0.1.0\n');
  mkdirSync(path.join(dir, 'src'));
  return dir;
}

const blocked = (input, cwd) => checkPath(input, cwd).blocked;

test('fold: NFC, ignorable characters, stream suffixes, trailing dots and spaces, ASCII case', () => {
  assert.equal(fold('.ROUGH-RIDE'), '.rough-ride');
  assert.equal(fold('.rough\u200c-ride'), '.rough-ride');
  assert.equal(fold('.rough-ride::$INDEX_ALLOCATION'), '.rough-ride');
  assert.equal(fold('.rough-ride. . '), '.rough-ride');
  assert.equal(fold('C:'), 'c:');
  assert.equal(fold('Cafe\u0301'), 'caf\u00e9');
});

const ROWS = [
  ['.ROUGH-RIDE/flows/x.yaml', (d) => ['.ROUGH-RIDE/flows/x.yaml', d], true],
  ['.rough-ride./x', (d) => ['.rough-ride./x', d], true],
  ['.rough-ride /x', (d) => ['.rough-ride /x', d], true],
  ['.rough-ride::$INDEX_ALLOCATION\\x', (d) => ['.rough-ride::$INDEX_ALLOCATION\\x', d], true],
  ['a case-variant folder', (d) => [path.join(d, '.Rough-Ride', 'new.yaml'), d], true],
  ['a nested frontend/.rough-ride/', (d) => [path.join(d, 'frontend', '.rough-ride', '.env'), d], true],
  ['an app file', (d) => [path.join(d, 'src', 'app.ts'), d], false],
  ['rough-ride without the dot', (d) => [path.join(d, 'rough-ride', 'x.yaml'), d], false],
];

for (const [name, make, expected] of ROWS) {
  test(`row: ${name}`, () => {
    const dir = tree();
    const [input, cwd] = make(dir);
    assert.equal(blocked(input, cwd), expected);
  });
}

test('row: forward slashes on Windows', onlyWindows, () => {
  const dir = tree();
  assert.equal(blocked(dir.replace(/\\/g, '/') + '/.rough-ride/flows/x.yaml', dir), true);
});

test('row: \\\\?\\C:\\... on Windows', onlyWindows, () => {
  const dir = tree();
  assert.equal(blocked('\\\\?\\' + path.join(dir, '.rough-ride', 'flows', 'x.yaml'), dir), true);
});

test('row: \\\\localhost\\C$\\... on Windows', onlyWindows, () => {
  const dir = tree();
  const unc = '\\\\localhost\\' + dir[0] + '$' + dir.slice(2);
  assert.equal(blocked(path.join(unc, '.rough-ride', 'flows', 'x.yaml'), dir), true);
});

test('row: a junction or directory symlink into flows/', () => {
  const dir = tree();
  symlinkSync(path.join(dir, '.rough-ride', 'flows'), path.join(dir, 'src', 'alias'), 'junction');
  assert.equal(blocked(path.join(dir, 'src', 'alias', 'new.yaml'), dir), true);
});

test('row: a link into the folder followed by ..', () => {
  const dir = tree();
  symlinkSync(path.join(dir, '.rough-ride', 'flows'), path.join(dir, 'src', 'alias'), 'junction');
  // Lexically this is src/x.yaml; physically it is .rough-ride/x.yaml.
  const result = checkPath(dir + path.sep + ['src', 'alias', '..', 'x.yaml'].join(path.sep), dir);
  assert.deepEqual(result, { blocked: true, rest: ['x.yaml'] });
});

test('row: a link out of the folder followed by ..', () => {
  const dir = tree();
  mkdirSync(path.join(dir, 'elsewhere', 'deep'), { recursive: true });
  symlinkSync(path.join(dir, 'elsewhere', 'deep'), path.join(dir, '.rough-ride', 'out'), 'junction');
  assert.equal(blocked(dir + path.sep + ['.rough-ride', 'out', '..', 'x.yaml'].join(path.sep), dir), true);
});

test('row: a dangling symlink to a new file in flows/', { skip: win && 'file symlinks need privileges on Windows' }, () => {
  const dir = tree();
  symlinkSync(path.join(dir, '.rough-ride', 'flows', 'new.yaml'), path.join(dir, 'src', 'new.yaml'));
  assert.deepEqual(checkPath(path.join(dir, 'src', 'new.yaml'), dir), { blocked: true, rest: ['flows', 'new.yaml'] });
});

test('row: an NFD parent', () => {
  const dir = tree();
  const nfd = path.join(dir, 'Cafe\u0301');
  mkdirSync(path.join(nfd, '.rough-ride'), { recursive: true });
  assert.equal(blocked(path.join(nfd, '.rough-ride', 'x.yaml'), dir), true);
  assert.equal(canon(path.join(nfd, 'missing')), canon(nfd) + '/missing');
  assert.ok(canon(nfd).endsWith('Caf\u00e9'));
});

test('row: /tmp against /private/tmp', onlyMac, () => {
  assert.equal(canon('/tmp/rough-ride-missing/x'), '/private/tmp/rough-ride-missing/x');
  assert.ok(samePath('/tmp', '/private/tmp'));
});

test('row: a /System/Volumes/Data spelling', onlyMac, () => {
  assert.ok(samePath(path.join('/System/Volumes/Data', homedir()), homedir()));
});

test('row: a hard-linked flow is invisible to the hook, so the runner refuses to read it', () => {
  const root = gitRepo();
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  const flow = path.join(root, '.rough-ride', 'flows', 'x.yaml');
  writeFileSync(flow, 'schema: 0.1.0\n');
  linkSync(flow, path.join(root, 'src.yaml'));
  assert.equal(blocked(path.join(root, 'src.yaml'), root), false);
  assert.throws(() => readFolderFile(checkRootEntry(root), 'flows', 'x.yaml'), StopError);
});

function shortNamesOn(dir) {
  if (!win) return false;
  try {
    return /is enabled/i.test(execFileSync('fsutil', ['8dot3name', 'query', dir.slice(0, 2)], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

test('row: ROUGH-~1', (t) => {
  const dir = tree();
  if (!shortNamesOn(dir)) {
    t.skip('8.3 short names are off on this volume');
    return;
  }
  assert.equal(blocked(path.join(dir, 'ROUGH-~1', 'flows', 'x.yaml'), dir), true);
});

test('canon cleans the string and keeps the missing tail as written', () => {
  const dir = scratchDir();
  assert.equal(canon(path.join(dir, 'Missing', 'Tail') + path.sep), canon(dir) + '/Missing/Tail');
  assert.ok(!canon(dir).includes('\\'));
});

// Rows for paths that do not exist, so they run on every OS with any platform.
const MISSING = '/no-such-rough-ride-dir';
const SAME_ROWS = [
  ['a trailing slash', `${MISSING}/a/`, `${MISSING}/a`, 'linux', true],
  ['letter case on Linux', `${MISSING}/A`, `${MISSING}/a`, 'linux', false],
  ['letter case of a missing folder on macOS', `${MISSING}/Data`, `${MISSING}/data`, 'darwin', true],
  ['another folder on macOS', `${MISSING}/data`, `${MISSING}/date`, 'darwin', false],
  ['backslashes, forward slashes and drive-letter case', 'c:\\No\\Such\\Data\\', 'C:/No/Such/Data', 'win32', true],
  ['a \\\\?\\ prefix', '\\\\?\\C:\\No\\Such', 'C:\\No\\Such', 'win32', true],
  ['letter case of a missing folder on Windows', 'C:\\No\\Such\\DATA', 'C:\\no\\such\\data', 'win32', true],
  ['another drive', 'C:\\No\\Such', 'D:\\No\\Such', 'win32', false],
];

for (const [name, a, b, platform, expected] of SAME_ROWS) {
  test(`samePath row (${platform}): ${name}`, () => {
    assert.equal(samePath(a, b, platform), expected);
    assert.equal(samePath(b, a, platform), expected);
  });
}

test('samePath: the file system decides for folders that exist', () => {
  const dir = scratchDir();
  mkdirSync(path.join(dir, 'Data'));
  symlinkSync(path.join(dir, 'Data'), path.join(dir, 'alias'), 'junction');
  assert.ok(samePath(path.join(dir, 'alias'), path.join(dir, 'Data')));
  if (caseSensitive(dir)) {
    // Two real folders that differ only in letter case stay two folders, even
    // under macOS's or Windows's platform rule; so does a missing case variant.
    mkdirSync(path.join(dir, 'data'));
    assert.equal(samePath(path.join(dir, 'Data'), path.join(dir, 'data'), 'darwin'), false);
    assert.equal(samePath(path.join(dir, 'Data'), path.join(dir, 'DATA'), 'darwin'), false);
  } else {
    assert.ok(samePath(path.join(dir, 'DATA'), path.join(dir, 'Data')));
  }
});

const INSIDE_ROWS = [
  ['below', `${MISSING}/a/b`, `${MISSING}/a`, 'linux', true],
  ['the folder itself', `${MISSING}/a`, `${MISSING}/a/`, 'linux', true],
  ['a sibling sharing the prefix', `${MISSING}/ab`, `${MISSING}/a`, 'linux', false],
  ['out with ..', `${MISSING}/a/../b`, `${MISSING}/a`, 'linux', false],
  ['letter case on Linux', `${MISSING}/A/b`, `${MISSING}/a`, 'linux', false],
  ['letter case of a missing folder on macOS', `${MISSING}/A/b`, `${MISSING}/a`, 'darwin', true],
  ['the root', `${MISSING}/a`, '/', 'linux', true],
  ['mixed slashes and drive-letter case', 'c:\\No\\Such\\A\\b', 'C:/No/Such/A', 'win32', true],
  ['letter case of a missing folder on Windows', 'C:\\No\\Such\\a\\b', 'C:\\No\\Such\\A', 'win32', true],
  ['a drive root', 'C:\\No', 'C:\\', 'win32', true],
  ['another drive', 'D:\\No\\Such\\A', 'C:\\No\\Such', 'win32', false],
];

for (const [name, child, parent, platform, expected] of INSIDE_ROWS) {
  test(`inside row (${platform}): ${name}`, () => {
    assert.equal(inside(child, parent, platform), expected);
    // What is inside could be inside.
    if (expected) assert.equal(couldBeInside(child, parent, platform), true);
  });
}

test('inside follows links; couldBeInside also takes the path as written', () => {
  const dir = scratchDir();
  mkdirSync(path.join(dir, 'root'));
  mkdirSync(path.join(dir, 'outside'));
  symlinkSync(path.join(dir, 'outside'), path.join(dir, 'root', 'link'), 'junction');
  symlinkSync(path.join(dir, 'root'), path.join(dir, 'into'), 'junction');
  const viaLink = path.join(dir, 'root', 'link', 'x.md');
  assert.equal(inside(viaLink, path.join(dir, 'root')), false);
  assert.equal(couldBeInside(viaLink, path.join(dir, 'root')), true);
  assert.equal(inside(path.join(dir, 'into', 'x.md'), path.join(dir, 'root')), true);
  assert.equal(couldBeInside(path.join(dir, 'outside', 'x.md'), path.join(dir, 'root')), false);
});

test('couldBeInside ignores letter case on macOS and Windows, even for folders that exist', () => {
  const dir = scratchDir();
  mkdirSync(path.join(dir, 'projects'));
  const sensitive = caseSensitive(dir);
  if (sensitive) mkdirSync(path.join(dir, 'Projects'));
  const child = path.join(dir, 'Projects', 'x.jsonl');
  assert.equal(couldBeInside(child, path.join(dir, 'projects'), 'darwin'), true);
  if (sensitive) {
    assert.equal(couldBeInside(child, path.join(dir, 'projects'), 'linux'), false);
    assert.equal(inside(child, path.join(dir, 'projects'), 'darwin'), false);
  }
});

const PRINTED_ROWS = [
  ['an absolute Windows path', 'C:\\Users\\u\\app', 'win32', 'C:/Users/u/app'],
  ['a relative Windows path', 'frontend\\package.json', 'win32', 'frontend/package.json'],
  ['forward slashes on Windows', 'C:/Users/u', 'win32', 'C:/Users/u'],
  ['a POSIX path', '/home/u/app', 'linux', '/home/u/app'],
  ['a backslash, a file-name character on POSIX', '/home/u/a\\b', 'linux', '/home/u/a\\b'],
  ['a macOS path', 'frontend/package.json', 'darwin', 'frontend/package.json'],
];

for (const [name, given, platform, expected] of PRINTED_ROWS) {
  test(`printed row (${platform}): ${name}`, () => {
    assert.equal(printed(given, platform), expected);
  });
}

test('printed defaults to this OS: a joined path prints with forward slashes', () => {
  assert.equal(printed(path.join('frontend', 'package.json')), 'frontend/package.json');
});
