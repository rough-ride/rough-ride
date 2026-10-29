// Run under a real old Node in CI (the unit tests fake the version): the entry
// file must parse, print the exact stop and exit 69.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const expected =
  `rough-ride needs Node.js 22.22.0 or later; this is Node ${process.versions.node} at ${process.execPath}.` +
  " A per-project version manager (Volta, asdf, mise, fnm, nvm) may have picked it from this project's settings." +
  ' Install Node 22.22 or later for this project and run again.';

const text = spawnSync(process.execPath, [cli, 'quick'], { encoding: 'utf8' });
assert.equal(text.status, 69);
assert.equal(text.stdout, expected + '\n');

const json = spawnSync(process.execPath, [cli, 'quick', '--json'], { encoding: 'utf8' });
assert.equal(json.status, 69);
assert.deepEqual(JSON.parse(json.stdout).stop, { code: 'node-too-old', kind: 'environment', lines: [expected] });
console.log(`Node ${process.versions.node}: stop printed and exit 69`);
