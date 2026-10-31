// The table-driven test of the edit guard hook, hooks/guard.mjs (spec part 6
// section 28 Acceptance, part 11 section 46 Acceptance). Each row spawns the
// hook with fixture stdin, as Claude Code would. Not covered here: `node`
// missing from PATH, which is Claude Code's handling of a hook that can't
// start (handler A's onFailure: block); that needs a real session.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scratchDir } from './helpers.mjs';
import { ADV, RUN, guardWorld, verdict } from './fixtures/hook-rows.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const GUARD = path.join(PKG, 'hooks', 'guard.mjs');

// The rows, the repository and the data folder, shared with scripts/hook-fixtures.mjs.
const { repo, projectDir, data, B, adv, tool, bash, ROWS, CASE_ROWS, READ_ROWS, BLOCK, record, stopInput, sessionFile } = guardWorld(PKG);

// A folder with a fake `git` that leaves a marker when anything runs it.
const fakeBin = scratchDir();
const gitMarker = path.join(fakeBin, 'git-ran');
writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\ntouch "${gitMarker}"\n`);
chmodSync(path.join(fakeBin, 'git'), 0o755);
writeFileSync(path.join(fakeBin, 'git.cmd'), `@echo off\r\ntype nul > "${gitMarker}"\r\n`);

function guard(stdin, { args = [], env = {}, pathEnv } = {}) {
  const r = spawnSync(process.execPath, [GUARD, ...args], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    cwd: repo,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, PATH: pathEnv ?? process.env.PATH, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function check(rows, opts) {
  for (const [name, stdin, expected, args, env] of rows) {
    const r = guard(stdin, { args, env, ...opts });
    assert.equal(r.code, 0, `${name}: exit code`);
    assert.equal(r.stderr, '', `${name}: stderr`);
    assert.equal(verdict(r.stdout), expected, name);
  }
}

test('handlers A and B: rules 1 to 7, table-driven', () => {
  check(ROWS);
});

test('rule 7: a plugin root or data folder in other letter case', { skip: CASE_ROWS.length === 0 && 'case-sensitive file system' }, () => {
  check(CASE_ROWS);
});

test('the same answers with git absent from PATH, and no git process starts', () => {
  check(ROWS, { pathEnv: fakeBin });
  assert.ok(!existsSync(gitMarker), 'the fake git never ran');
});

test('unreadable or empty stdin prints nothing and exits 0', () => {
  for (const [stdin, args] of [['', B], ['not json', B], ['null', []], ['{}', ['read']], ['[]', ['stop', data]]]) {
    const r = guard(stdin, { args });
    assert.deepEqual([r.code, r.stdout], [0, ''], JSON.stringify(stdin));
  }
});

// ---- Handler C ----

test('handler C: the adversary may read its run folder and app source, nothing listed', () => {
  for (const [name, stdin, expected] of READ_ROWS) {
    const asAdversary = guard({ ...stdin, agent_type: ADV }, { args: ['read'] });
    assert.equal(asAdversary.code, 0);
    assert.equal(verdict(asAdversary.stdout), expected, name);
    // Without the adversary's agent_type, the same read exits at once.
    const asOther = guard(stdin, { args: ['read'] });
    assert.deepEqual([asOther.code, asOther.stdout], [0, ''], `${name}, no agent_type`);
    const asAnother = guard({ ...stdin, agent_type: 'general-purpose' }, { args: ['read'] });
    assert.deepEqual([asAnother.code, asAnother.stdout], [0, ''], `${name}, another agent`);
  }
});

// ---- The SubagentStop check ----

const stop = (input) => {
  const r = guard(input, { args: ['stop', data] });
  assert.equal(r.code, 0);
  return verdict(r.stdout);
};

test('SubagentStop: planned and not attacked blocks once with the attack command, then shows the user line', () => {
  const rec = record('stop-planned', {});
  assert.equal(stop(stopInput('stop-planned')), `block: Run node "${PKG}/dist/cli.mjs" attack --run ${RUN} --plugin-data "${data}" before you finish.`);
  assert.equal(
    stop(stopInput('stop-planned', { stop_hook_active: true })),
    `message: rough-ride: the adversary stopped before attacking run ${RUN}, so nothing was attacked. To run the selected attacks with nothing added: node "${rec.cli}" attack --run ${RUN} --plugin-data "${data}"`,
  );
  // The block's own command passes rule 7.
  const command = `node "${PKG}/dist/cli.mjs" attack --run ${RUN} --plugin-data "${data}"`;
  assert.equal(verdict(guard(bash(command, adv), { args: B }).stdout), 'allow');
});

test('SubagentStop: a final message missing the block is blocked once, then shows the user line', () => {
  const rec = record('stop-missing', { attacked: true });
  const lacking = { last_assistant_message: 'All done, two findings.' };
  assert.equal(stop(stopInput('stop-missing', lacking)), `block: Your final message must contain the runner's summary block from ${rec.summaryPath} exactly.`);
  assert.equal(
    stop(stopInput('stop-missing', { ...lacking, stop_hook_active: true })),
    `message: rough-ride: the adversary's report left out the runner's summary for run ${RUN}: ${rec.summaryPath}`,
  );
  // CRLF line endings in the final message still count as the block.
  assert.equal(stop(stopInput('stop-missing', { last_assistant_message: '```text\r\n' + BLOCK.replace(/\n/g, '\r\n') + '```' })), '');
});

test('SubagentStop: a run that never got a folder names the session file', () => {
  record('stop-null', { run: null, attacked: false, summaryPath: null });
  const file = sessionFile('stop-null');
  assert.equal(stop(stopInput('stop-null', { last_assistant_message: 'x' })), `block: Your final message must contain the runner's summary block from ${file} exactly.`);
  assert.equal(stop(stopInput('stop-null', { last_assistant_message: 'x', stop_hook_active: true })), `message: rough-ride: the adversary's report left out the runner's summary: ${file}`);
  assert.equal(stop(stopInput('stop-null')), '');
});

test('SubagentStop: lets the stop through when the run was attacked and quoted, or nothing can be checked', () => {
  record('stop-good', { attacked: true });
  assert.equal(stop(stopInput('stop-good')), '');
  assert.equal(stop(stopInput('stop-good', { stop_hook_active: true })), '');
  // No final message in the input: only the planned-not-attacked rule applies.
  assert.equal(stop(stopInput('stop-good', { last_assistant_message: undefined })), '');
  // No session file, another agent, a forged hash, no plugin data folder.
  assert.equal(stop(stopInput('stop-none')), '');
  record('stop-other', {});
  assert.equal(stop(stopInput('stop-other', { agent_type: 'general-purpose' })), '');
  record('stop-forged', { summarySha256: '0'.repeat(64) });
  assert.equal(stop(stopInput('stop-forged')), '');
  const r = guard(stopInput('stop-other'), { args: ['stop'] });
  assert.deepEqual([r.code, r.stdout], [0, '']);
});

test('SubagentStop: the final message changes no field of the session file', () => {
  const before = record('stop-same', {});
  const file = sessionFile('stop-same');
  const text = readFileSync(file, 'utf8');
  stop(stopInput('stop-same', { last_assistant_message: 'changed' }));
  stop(stopInput('stop-same', { last_assistant_message: undefined }));
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.deepEqual(JSON.parse(text), before);
});

test('hooks.json registers handlers A, B and C and the SubagentStop check in exec form', () => {
  const hooks = JSON.parse(readFileSync(path.join(PKG, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const script = '${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs';
  const entry = (matcher, extra, args) => ({ matcher, hooks: [{ type: 'command', ...extra, command: 'node', args, timeout: 5 }] });
  const read = (pattern) => entry('Read|Grep|Glob', { if: `Read(//**/${pattern})` }, [script, 'read']);
  assert.deepEqual(hooks.PreToolUse, [
    ...['Edit', 'Write', 'NotebookEdit'].map((t) => ({
      matcher: t,
      hooks: [{ type: 'command', if: `${t}(//**/.rough-ride/**)`, command: 'node', args: [script], timeout: 5, onFailure: 'block' }],
    })),
    entry('Edit|Write|NotebookEdit|Bash|PowerShell|Agent|Task|Skill|mcp__.*', {}, [script, '${CLAUDE_PLUGIN_DATA}']),
    ...['.claude/**', 'projects/**', '.git/**', '.rough-ride/runs/**', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.env', '.env.*', '*.pem', '*.key', '.ssh/**', '.aws/**', '.npmrc', '.netrc'].map(read),
    entry('Grep|Glob', {}, [script, 'read']),
  ]);
  assert.deepEqual(hooks.SubagentStop, [entry('rough-ride:adversary', {}, [script, 'stop', '${CLAUDE_PLUGIN_DATA}'])]);
});
