// The table-driven test of the edit guard hook, hooks/guard.mjs (spec part 6
// section 28 Acceptance, part 11 section 46 Acceptance). Each row spawns the
// hook with fixture stdin, as Claude Code would. Not covered here: `node`
// missing from PATH, which is Claude Code's handling of a hook that can't
// start (handler A's onFailure: block); that needs a real session.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scratchDir } from './helpers.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const GUARD = path.join(PKG, 'hooks', 'guard.mjs');
const VERSION = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
const caseless = process.platform === 'darwin' || process.platform === 'win32';

const RULE1 =
  'Files under .rough-patch/ are changed only by rough-patch and by people. Read them with the Read tool, and tell the user what you wanted to change.';
const RULE2 = 'Commands that name .rough-patch/ are blocked. Read its files with the Read tool; stage them with git add.';
const RULE3 =
  'flow save, link and attack --plan are run only by rough-patch:adversary, which /rough-patch:quick and /rough-patch:standard start. Run one of those skills instead.';
const RULE4 =
  'rough-patch:adversary is started only by /rough-patch:quick and /rough-patch:standard. Run one of those skills, with nothing after the name.';
const RULE5 =
  `rough-patch runs only from its exact version or the project's own install: npx -y rough-patch@${VERSION} quick, ` +
  'or npx --no rough-patch quick. Unpinned versions and lookalike names are blocked.';
const RULE6 =
  "rough-patch's /rough-patch:quick and /rough-patch:standard take no arguments. Run them with nothing after the name; for another tool's quick skill, use its full name.";
const RULE7 =
  "rough-patch:adversary runs only rough-patch's own commands, typed from the prefix in its instructions. Put anything else in your notes.";
const READ =
  "rough-patch:adversary doesn't read Claude Code's files, instruction files, secrets or other run output. Work from the repository and your run's adversary folder.";

const ADV = 'rough-patch:adversary';
const RUN = '20261025-141207-quick-k3fz';

// A folder with a fake `git` that leaves a marker when anything runs it.
const fakeBin = scratchDir();
const gitMarker = path.join(fakeBin, 'git-ran');
writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\ntouch "${gitMarker}"\n`);
chmodSync(path.join(fakeBin, 'git'), 0o755);
writeFileSync(path.join(fakeBin, 'git.cmd'), `@echo off\r\ntype nul > "${gitMarker}"\r\n`);

const repo = scratchDir();
const projectDir = scratchDir();
const data = scratchDir();
mkdirSync(path.join(repo, 'frontend'), { recursive: true });
mkdirSync(path.join(repo, '.rough-patch', 'flows'), { recursive: true });
// `shared` resolves into the folder only from CLAUDE_PROJECT_DIR, not from cwd.
symlinkSync(path.join(repo, '.rough-patch'), path.join(projectDir, 'shared'), 'junction');

function guard(stdin, { args = [], env = {}, pathEnv } = {}) {
  const r = spawnSync(process.execPath, [GUARD, ...args], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    cwd: repo,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, PATH: pathEnv ?? process.env.PATH, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// What the hook decided: 'deny: <reason>', 'allow', 'block: <reason>',
// 'message: <text>', or '' for nothing.
function verdict(stdout) {
  if (stdout === '') return '';
  const out = JSON.parse(stdout);
  if (out.hookSpecificOutput) {
    const h = out.hookSpecificOutput;
    assert.equal(h.hookEventName, 'PreToolUse');
    return h.permissionDecision === 'deny' ? `deny: ${h.permissionDecisionReason}` : h.permissionDecision;
  }
  if (out.decision === 'block') return `block: ${out.reason}`;
  if (out.systemMessage) return `message: ${out.systemMessage}`;
  return stdout;
}

const tool = (tool_name, tool_input, extra = {}) => ({ hook_event_name: 'PreToolUse', cwd: repo, session_id: 's1', tool_name, tool_input, ...extra });
const bash = (command, extra) => tool('Bash', { command }, extra);
const cli = (rest, { root = PKG, folder = data, body } = {}) =>
  `node "${root}/dist/cli.mjs" ${rest} --plugin-data "${folder}"` + (body === undefined ? '' : ` <<'RP_END'\n${body}RP_END`);
const adv = { agent_type: ADV };

const other = (s) => s.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

// [name, stdin, expected verdict, args]. Handler B rows pass the data folder.
const B = [data];
const ROWS = [
  // Rule 1: file tools, every agent_type.
  ...['.ROUGH-PATCH', '.rough-patch.', '.rough-patch::$INDEX_ALLOCATION'].flatMap((seg) =>
    ['Edit', 'Write', 'NotebookEdit'].flatMap((t) =>
      [{}, adv, { agent_type: 'general-purpose' }].map((extra) => [
        `rule 1: ${t} to ${seg} (${extra.agent_type ?? 'no agent_type'})`,
        tool(t, t === 'NotebookEdit' ? { notebook_path: path.join(repo, seg, 'x.ipynb') } : { file_path: path.join(repo, seg, 'flows', 'x.yaml') }, extra),
        `deny: ${RULE1}`,
        B,
      ]),
    ),
  ),
  ['rule 1: handler A (no args) denies the same Write', tool('Write', { file_path: path.join(repo, '.rough-patch', 'flows', 'x.yaml') }), `deny: ${RULE1}`, []],
  ['rule 1: Edit to app source passes', tool('Edit', { file_path: path.join(repo, 'frontend', 'app.vue') }), '', B],
  ['rule 1: MCP filePath under the git root', tool('mcp__chrome-devtools__take_screenshot', { filePath: path.join(repo, '.rough-patch', 'runs', 'x.png') }), `deny: ${RULE1}`, B],
  ['rule 1: nested relative MCP path under cwd', tool('mcp__fs__write', { options: { path: '.rough-patch/flows/x.yaml' } }), `deny: ${RULE1}`, B],
  ['rule 1: nested relative MCP path resolving under CLAUDE_PROJECT_DIR only', tool('mcp__fs__write', { options: { path: 'shared/flows/x.yaml' } }), `deny: ${RULE1}`, B],
  ['rule 1: the same relative path without CLAUDE_PROJECT_DIR passes', tool('mcp__fs__write', { options: { path: 'shared/flows/x.yaml' } }), '', B, { CLAUDE_PROJECT_DIR: '' }],
  ['rule 1: MCP file and filename keys', tool('mcp__fs__write', { list: [{ FILE: '.rough-patch/x' }] }), `deny: ${RULE1}`, B],
  ['rule 1: MCP path elsewhere passes', tool('mcp__fs__write', { path: 'frontend/app.vue', note: '.rough-patch' }), '', B],

  // Rule 2: shell commands naming the folder.
  ['rule 2: cat a flow', bash('cat .rough-patch/flows/x.yaml'), `deny: ${RULE2}`, B],
  ['rule 2: sed with backslashes and mixed case', bash('sed -i s/a/b/ .Rough-Patch\\flows\\x.yaml'), `deny: ${RULE2}`, B],
  ['rule 2: 8.3 short name', bash('echo x > ROUGH-~1/x'), `deny: ${RULE2}`, B],
  ['rule 2: PowerShell', tool('PowerShell', { command: 'Get-Content .rough-patch\\flows\\x.yaml' }), `deny: ${RULE2}`, B],
  ['rule 2: git add of a test passes', bash('git add .rough-patch/tests/create-note-500-a41f0c.yaml'), '', B],
  ['rule 2: git status passes', bash('git status'), '', B],
  ['rule 2: git add chained with rm', bash('git add .rough-patch/x && rm -rf .rough-patch'), `deny: ${RULE2}`, B],
  ['rule 2: git diff --output', bash('git diff --output=out .rough-patch'), `deny: ${RULE2}`, B],
  ['rule 2: git diff --ext-diff', bash('git diff --ext-diff .rough-patch'), `deny: ${RULE2}`, B],
  ['rule 2: rough-patch without the dot passes', bash('npx --no rough-patch quick'), '', B],

  // Rule 3: adversary-only subcommands.
  ['rule 3: flow save without agent_type', bash(cli(`flow save create-note:n1 --run ${RUN}`)), `deny: ${RULE3}`, B],
  ['rule 3: flow save from another agent', bash(cli(`flow save create-note:n1 --run ${RUN}`), { agent_type: 'general-purpose' }), `deny: ${RULE3}`, B],
  ['rule 3: link', bash(cli(`link --run ${RUN}`)), `deny: ${RULE3}`, B],
  ['rule 3: attack --plan -', bash(cli(`attack --run ${RUN} --plan -`)), `deny: ${RULE3}`, B],
  ['rule 3: npx flow save', bash('npx --no rough-patch flow save create-note'), `deny: ${RULE3}`, B],
  ['rule 3: attack --run with no plan passes', bash(cli(`attack --run ${RUN}`)), '', B],
  ['rule 3: flow save for the adversary passes', bash(cli(`flow save create-note:n1 --run ${RUN}`), adv), 'allow', B],

  // Rule 4: direct adversary spawns.
  ['rule 4: Agent', tool('Agent', { subagent_type: ADV, prompt: 'x' }), `deny: ${RULE4}`, B],
  ['rule 4: Task', tool('Task', { subagent_type: ADV, prompt: 'x' }), `deny: ${RULE4}`, B],
  ['rule 4: another agent passes', tool('Agent', { subagent_type: 'general-purpose', prompt: 'x' }), '', B],

  // Rule 5: lookalike or unpinned runners.
  ...['npx rough-patch quick', 'npx rough-patch@latest quick', 'npx rough-patch@^0.4.0 quick', 'pnpm dlx Rough_Patch@0.4.0', 'bunx @roughpatch/cli', 'npm exec rough-patch quick', 'yarn dlx rough.patch@0.4.0', 'bun x rough-patch', 'npx -p rough-patch rough-patch quick']
    .map((c) => [`rule 5: ${c}`, bash(c), `deny: ${RULE5}`, B]),
  ...['npx -y rough-patch@0.4.0 quick', 'npx --no rough-patch quick', 'npx --no -- rough-patch --version', 'npx prettier --check .', 'pnpm dlx rough-patch@1.2.3-rc.1']
    .map((c) => [`rule 5: ${c} passes`, bash(c), '', B]),

  // Rule 6: the skills take no arguments.
  ['rule 6: rough-patch:quick with arguments', tool('Skill', { skill: 'rough-patch:quick', args: 'focus on login' }), `deny: ${RULE6}`, B],
  ['rule 6: rough-patch:quick alone passes', tool('Skill', { skill: 'rough-patch:quick' }), '', B],
  ['rule 6: blank arguments pass', tool('Skill', { skill: 'rough-patch:quick', args: '  ' }), '', B],
  ['rule 6: STANDARD with arguments', tool('Skill', { skill: 'STANDARD', args: 'x' }), `deny: ${RULE6}`, B],
  ['rule 6: other-tool:quick with arguments passes', tool('Skill', { skill: 'other-tool:quick', args: 'x' }), '', B],

  // Rule 7: the adversary runs only the runner.
  ['rule 7: plan quick', bash(cli('plan quick'), adv), 'allow', B],
  ['rule 7: plan standard', bash(cli('plan standard'), adv), 'allow', B],
  ['rule 7: snapshot with a body', bash(cli(`snapshot --run ${RUN}`, { body: 'steps:\n  - goto: /notes\n' }), adv), 'allow', B],
  ['rule 7: link with a body', bash(cli(`link --run ${RUN}`, { body: '- {file: a.vue, page: /a, because: x}\n' }), adv), 'allow', B],
  ['rule 7: flow save of several names', bash(cli(`flow save create-note:n1 sign-in edit-tag:l2 --run ${RUN}`, { body: 'steps: []\n---\nsteps: []\n---\nsteps: []\n' }), adv), 'allow', B],
  ['rule 7: attack', bash(cli(`attack --run ${RUN}`), adv), 'allow', B],
  ['rule 7: attack --plan - --check with a body holding | > &', bash(cli(`attack --run ${RUN} --plan - --check`, { body: 'attacks:\n  - {flow: a, because: "x | y > z & w"}\nnote: |\n  a > b\n' }), adv), 'allow', B],
  ['rule 7: attack --check --plan -', bash(cli(`attack --run ${RUN} --check --plan -`, { body: 'attacks: []\n' }), adv), 'allow', B],
  ['rule 7: ; outside the body', bash(cli('plan quick') + '; echo hi', adv), `deny: ${RULE7}`, B],
  ['rule 7: | outside the body', bash(cli('plan quick') + ' | tee x', adv), `deny: ${RULE7}`, B],
  ['rule 7: $( outside the body', bash(cli(`attack --run $(cat id)`), adv), `deny: ${RULE7}`, B],
  ...['--base main', '--start', '--keep-open', '--json'].map((flag) => [`rule 7: ${flag}`, bash(cli(`plan quick ${flag}`), adv), `deny: ${RULE7}`, B]),
  ['rule 7: another CLI path', bash(cli('plan quick', { root: scratchDir() }), adv), `deny: ${RULE7}`, B],
  ['rule 7: another data folder', bash(cli('plan quick', { folder: scratchDir() }), adv), `deny: ${RULE7}`, B],
  ['rule 7: a relative CLI path', bash(cli('plan quick', { root: '.' }), adv), `deny: ${RULE7}`, B],
  ['rule 7: no data folder in the hook args', bash(cli('plan quick'), adv), `deny: ${RULE7}`, []],
  ['rule 7: a body with a line RP_END', bash(cli(`link --run ${RUN}`, { body: 'x\nRP_END\nrm -rf ~\n' }), adv), `deny: ${RULE7}`, B],
  ['rule 7: an unterminated heredoc', bash(cli(`link --run ${RUN}`) + " <<'RP_END'\nx\n", adv), `deny: ${RULE7}`, B],
  ['rule 7: a body naming .rough-patch is rule 2', bash(cli(`link --run ${RUN}`, { body: '- {file: .rough-patch/x}\n' }), adv), `deny: ${RULE2}`, B],
  ['rule 7: a bad run id', bash(cli('snapshot --run 2026-x'), adv), `deny: ${RULE7}`, B],
  ['rule 7: a bad flow name', bash(cli(`flow save Bad_Name --run ${RUN}`), adv), `deny: ${RULE7}`, B],
  ['rule 7: git status', bash('git status', adv), `deny: ${RULE7}`, B],
  ['rule 7: PowerShell', tool('PowerShell', { command: cli('plan quick') }, adv), `deny: ${RULE7}`, B],
  ['rule 7: an MCP call', tool('mcp__chrome-devtools__navigate_page', { url: 'http://localhost:3000' }, adv), `deny: ${RULE7}`, B],
  ['rule 7: Edit to the folder is still rule 1', tool('Write', { file_path: path.join(repo, '.rough-patch', 'flows', 'x.yaml') }, adv), `deny: ${RULE1}`, B],
];

const CASE_ROWS = [
  ['rule 7: the plugin root in other letter case', bash(cli('plan quick', { root: other(PKG) }), adv), 'allow', B],
  ['rule 7: the data folder in other letter case', bash(cli('plan quick', { folder: other(data) }), adv), 'allow', B],
];

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

test('rule 7: a plugin root or data folder in other letter case', { skip: !caseless && 'case-sensitive file system' }, () => {
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
  const transcriptDir = path.join(scratchDir(), 'projects', '-repo');
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = path.join(transcriptDir, 's1.jsonl');
  const runs = path.join(repo, '.rough-patch', 'runs', RUN);
  const read = (file_path, extra) => tool('Read', { file_path }, { transcript_path: transcript, ...extra });
  const rows = [
    ['CLAUDE.md', read(path.join(repo, 'CLAUDE.md')), `deny: ${READ}`],
    ['claude.md in lower case', read(path.join(repo, 'claude.md')), `deny: ${READ}`],
    ['AGENTS.md', read(path.join(repo, 'frontend', 'AGENTS.md')), `deny: ${READ}`],
    ['frontend/.env', read(path.join(repo, 'frontend', '.env')), `deny: ${READ}`],
    ['.env.local', read(path.join(repo, '.env.local')), `deny: ${READ}`],
    ['a key file', read(path.join(repo, 'certs', 'server.key')), `deny: ${READ}`],
    ['.git/config', read(path.join(repo, '.git', 'config')), `deny: ${READ}`],
    ['~/.ssh/id_ed25519', read(path.join(homedir(), '.ssh', 'id_ed25519')), `deny: ${READ}`],
    ['~/.claude settings', read(path.join(homedir(), '.claude', 'settings.json')), `deny: ${READ}`],
    ['runs/<id>/report.txt', read(path.join(runs, 'report.txt')), `deny: ${READ}`],
    ['another run folder escaped with ..', read(path.join(runs, 'adversary', '..', 'report.txt')), `deny: ${READ}`],
    ['a file in the transcript folder', read(path.join(transcriptDir, 'other-session.jsonl')), `deny: ${READ}`],
    ['runs/<id>/adversary/selection.json', read(path.join(runs, 'adversary', 'selection.json')), ''],
    ['app source', read(path.join(repo, 'frontend', 'app.vue')), ''],
    ['a flow file', read(path.join(repo, '.rough-patch', 'flows', 'x.yaml')), ''],
    ['another projects folder', read(path.join(scratchDir(), 'projects', 'x', 'y.ts')), ''],
    ['Grep over runs/', tool('Grep', { pattern: 'x', path: '.rough-patch/runs' }, {}), `deny: ${READ}`],
    ['Grep with a .env glob', tool('Grep', { pattern: 'x', glob: '**/.env' }, {}), `deny: ${READ}`],
    ['Glob into another run', tool('Glob', { pattern: `.rough-patch/runs/${RUN}/*.txt` }, {}), `deny: ${READ}`],
    ['Glob into the adversary folder', tool('Glob', { pattern: `.rough-patch/runs/${RUN}/adversary/*.json` }, {}), ''],
    ['Grep over the source', tool('Grep', { pattern: 'x', path: 'frontend' }, {}), ''],
  ];
  for (const [name, stdin, expected] of rows) {
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

const BLOCK = `--- rough-patch summary (copy this block unchanged) ---\nrough-patch plan | 2s | run ${RUN}\nFull report: /x/report.txt\n--- end of rough-patch summary ---\n`;

function record(sessionId, fields) {
  const dir = path.join(data, 'adversary-runs');
  mkdirSync(dir, { recursive: true });
  const summary = fields.summary ?? BLOCK;
  const value = {
    run: RUN,
    attacked: false,
    summary,
    summarySha256: createHash('sha256').update(summary).digest('hex'),
    cli: path.join(PKG, 'dist', 'cli.mjs'),
    pluginData: data,
    summaryPath: path.join(repo, '.rough-patch', 'runs', RUN, 'adversary', 'summary.txt'),
    ...fields,
  };
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(value));
  return value;
}

const stopInput = (session_id, extra) => ({
  hook_event_name: 'SubagentStop',
  session_id,
  cwd: repo,
  agent_type: ADV,
  agent_id: 'a1',
  stop_hook_active: false,
  last_assistant_message: '```text\n' + BLOCK + '```',
  ...extra,
});
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
    `message: rough-patch: the adversary stopped before attacking run ${RUN}, so nothing was attacked. To run the selected attacks with nothing added: node "${rec.cli}" attack --run ${RUN} --plugin-data "${data}"`,
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
    `message: rough-patch: the adversary's report left out the runner's summary for run ${RUN}: ${rec.summaryPath}`,
  );
  // CRLF line endings in the final message still count as the block.
  assert.equal(stop(stopInput('stop-missing', { last_assistant_message: '```text\r\n' + BLOCK.replace(/\n/g, '\r\n') + '```' })), '');
});

test('SubagentStop: a run that never got a folder names the session file', () => {
  record('stop-null', { run: null, attacked: false, summaryPath: null });
  const file = path.join(data, 'adversary-runs', 'stop-null.json');
  assert.equal(stop(stopInput('stop-null', { last_assistant_message: 'x' })), `block: Your final message must contain the runner's summary block from ${file} exactly.`);
  assert.equal(stop(stopInput('stop-null', { last_assistant_message: 'x', stop_hook_active: true })), `message: rough-patch: the adversary's report left out the runner's summary: ${file}`);
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
  const file = path.join(data, 'adversary-runs', 'stop-same.json');
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
      hooks: [{ type: 'command', if: `${t}(//**/.rough-patch/**)`, command: 'node', args: [script], timeout: 5, onFailure: 'block' }],
    })),
    entry('Edit|Write|NotebookEdit|Bash|PowerShell|Agent|Task|Skill|mcp__.*', {}, [script, '${CLAUDE_PLUGIN_DATA}']),
    ...['.claude/**', 'projects/**', '.git/**', '.rough-patch/runs/**', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.env', '.env.*', '*.pem', '*.key', '.ssh/**', '.aws/**', '.npmrc', '.netrc'].map(read),
    entry('Grep|Glob', {}, [script, 'read']),
  ]);
  assert.deepEqual(hooks.SubagentStop, [entry('rough-patch:adversary', {}, [script, 'stop', '${CLAUDE_PLUGIN_DATA}'])]);
});
