// The hook fixtures the unit tests and scripts/hook-fixtures.mjs share (ticket
// 56): the guard rows of guard-hook.test.mjs, the SubagentStop session files,
// and the plugins root and exact messages of plugin.test.mjs's session-start
// tests. Each takes the package folder, so the same rows run against the
// source tree or an unpacked tarball. Node 18 syntax: CI's hook job runs it
// on Node 18.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { scratchDir } from '../helpers.mjs';

export const ADV = 'rough-ride:adversary';
export const RUN = '20261025-141207-quick-k3fz';

export const RULE1 =
  'Files under .rough-ride/ are changed only by rough-ride and by people. Read them with the Read tool, and tell the user what you wanted to change.';
export const RULE2 = 'Commands that name .rough-ride/ are blocked. Read its files with the Read tool; stage them with git add.';
export const RULE3 =
  'flow save, link and attack --plan are run only by rough-ride:adversary, which /rough-ride:quick and /rough-ride:standard start. Run one of those skills instead.';
export const RULE4 =
  'rough-ride:adversary is started only by /rough-ride:quick and /rough-ride:standard. Run one of those skills, with nothing after the name.';
export const RULE5 = (version) =>
  `rough-ride runs only from its exact version or the project's own install: npx -y rough-ride@${version} quick, ` +
  'or npx --no rough-ride quick. Unpinned versions and lookalike names are blocked.';
export const RULE6 =
  "rough-ride's /rough-ride:quick and /rough-ride:standard take no arguments. Run them with nothing after the name; for another tool's quick skill, use its full name.";
export const RULE7 =
  "rough-ride:adversary runs only rough-ride's own commands, typed from the prefix in its instructions. Put anything else in your notes.";
export const READ =
  "rough-ride:adversary doesn't read Claude Code's files, instruction files, secrets or other run output. Work from the repository and your run's adversary folder.";

export const packageVersion = (pkg) => JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;

// What a hook decided: 'deny: <reason>', 'allow', 'block: <reason>',
// 'message: <text>', or '' for nothing. Throws on output no hook prints.
export function verdict(stdout) {
  if (stdout === '') return '';
  const out = JSON.parse(stdout);
  if (out.hookSpecificOutput) {
    const h = out.hookSpecificOutput;
    if (h.hookEventName !== 'PreToolUse') throw new Error(`hookEventName ${h.hookEventName}`);
    return h.permissionDecision === 'deny' ? `deny: ${h.permissionDecisionReason}` : h.permissionDecision;
  }
  if (out.decision === 'block') return `block: ${out.reason}`;
  if (out.systemMessage) return `message: ${out.systemMessage}`;
  return stdout;
}

const other = (s) => s.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

// A repository, a project folder and a plugin data folder for the guard, and
// the rows for the guard copy in `pkg`. The guard runs with cwd `repo` and
// CLAUDE_PROJECT_DIR `projectDir`.
export function guardWorld(pkg) {
  const VERSION = packageVersion(pkg);
  const repo = scratchDir();
  const projectDir = scratchDir();
  const data = scratchDir();
  mkdirSync(path.join(repo, 'frontend'), { recursive: true });
  mkdirSync(path.join(repo, '.rough-ride', 'flows'), { recursive: true });
  // `shared` resolves into the folder only from CLAUDE_PROJECT_DIR, not from cwd.
  symlinkSync(path.join(repo, '.rough-ride'), path.join(projectDir, 'shared'), 'junction');

  const tool = (tool_name, tool_input, extra = {}) => ({ hook_event_name: 'PreToolUse', cwd: repo, session_id: 's1', tool_name, tool_input, ...extra });
  const bash = (command, extra) => tool('Bash', { command }, extra);
  const cli = (rest, { root = pkg, folder = data, body } = {}) =>
    `node "${root}/dist/cli.mjs" ${rest} --plugin-data "${folder}"` + (body === undefined ? '' : ` <<'RP_END'\n${body}RP_END`);
  const adv = { agent_type: ADV };

  // [name, stdin, expected verdict, args, env]. Handler B rows pass the data folder.
  const B = [data];
  const ROWS = [
    // Rule 1: file tools, every agent_type.
    ...['.ROUGH-RIDE', '.rough-ride.', '.rough-ride::$INDEX_ALLOCATION'].flatMap((seg) =>
      ['Edit', 'Write', 'NotebookEdit'].flatMap((t) =>
        [{}, adv, { agent_type: 'general-purpose' }].map((extra) => [
          `rule 1: ${t} to ${seg} (${extra.agent_type ?? 'no agent_type'})`,
          tool(t, t === 'NotebookEdit' ? { notebook_path: path.join(repo, seg, 'x.ipynb') } : { file_path: path.join(repo, seg, 'flows', 'x.yaml') }, extra),
          `deny: ${RULE1}`,
          B,
        ]),
      ),
    ),
    ['rule 1: handler A (no args) denies the same Write', tool('Write', { file_path: path.join(repo, '.rough-ride', 'flows', 'x.yaml') }), `deny: ${RULE1}`, []],
    ['rule 1: Edit to app source passes', tool('Edit', { file_path: path.join(repo, 'frontend', 'app.vue') }), '', B],
    ['rule 1: MCP filePath under the git root', tool('mcp__chrome-devtools__take_screenshot', { filePath: path.join(repo, '.rough-ride', 'runs', 'x.png') }), `deny: ${RULE1}`, B],
    ['rule 1: nested relative MCP path under cwd', tool('mcp__fs__write', { options: { path: '.rough-ride/flows/x.yaml' } }), `deny: ${RULE1}`, B],
    ['rule 1: nested relative MCP path resolving under CLAUDE_PROJECT_DIR only', tool('mcp__fs__write', { options: { path: 'shared/flows/x.yaml' } }), `deny: ${RULE1}`, B],
    ['rule 1: the same relative path without CLAUDE_PROJECT_DIR passes', tool('mcp__fs__write', { options: { path: 'shared/flows/x.yaml' } }), '', B, { CLAUDE_PROJECT_DIR: '' }],
    ['rule 1: MCP file and filename keys', tool('mcp__fs__write', { list: [{ FILE: '.rough-ride/x' }] }), `deny: ${RULE1}`, B],
    ['rule 1: MCP path elsewhere passes', tool('mcp__fs__write', { path: 'frontend/app.vue', note: '.rough-ride' }), '', B],

    // Rule 2: shell commands naming the folder.
    ['rule 2: cat a flow', bash('cat .rough-ride/flows/x.yaml'), `deny: ${RULE2}`, B],
    ['rule 2: sed with backslashes and mixed case', bash('sed -i s/a/b/ .Rough-Ride\\flows\\x.yaml'), `deny: ${RULE2}`, B],
    ['rule 2: 8.3 short name', bash('echo x > ROUGH-~1/x'), `deny: ${RULE2}`, B],
    ['rule 2: PowerShell', tool('PowerShell', { command: 'Get-Content .rough-ride\\flows\\x.yaml' }), `deny: ${RULE2}`, B],
    ['rule 2: git add of a test passes', bash('git add .rough-ride/tests/create-note-500-a41f0c.yaml'), '', B],
    ['rule 2: git status passes', bash('git status'), '', B],
    ['rule 2: git add chained with rm', bash('git add .rough-ride/x && rm -rf .rough-ride'), `deny: ${RULE2}`, B],
    ['rule 2: git diff --output', bash('git diff --output=out .rough-ride'), `deny: ${RULE2}`, B],
    ['rule 2: git diff --ext-diff', bash('git diff --ext-diff .rough-ride'), `deny: ${RULE2}`, B],
    ['rule 2: rough-ride without the dot passes', bash('npx --no rough-ride quick'), '', B],

    // Rule 3: adversary-only subcommands.
    ['rule 3: flow save without agent_type', bash(cli(`flow save create-note:n1 --run ${RUN}`)), `deny: ${RULE3}`, B],
    ['rule 3: flow save from another agent', bash(cli(`flow save create-note:n1 --run ${RUN}`), { agent_type: 'general-purpose' }), `deny: ${RULE3}`, B],
    ['rule 3: link', bash(cli(`link --run ${RUN}`)), `deny: ${RULE3}`, B],
    ['rule 3: attack --plan -', bash(cli(`attack --run ${RUN} --plan -`)), `deny: ${RULE3}`, B],
    ['rule 3: npx flow save', bash('npx --no rough-ride flow save create-note'), `deny: ${RULE3}`, B],
    ['rule 3: attack --run with no plan passes', bash(cli(`attack --run ${RUN}`)), '', B],
    ['rule 3: flow save for the adversary passes', bash(cli(`flow save create-note:n1 --run ${RUN}`), adv), 'allow', B],

    // Rule 4: direct adversary spawns.
    ['rule 4: Agent', tool('Agent', { subagent_type: ADV, prompt: 'x' }), `deny: ${RULE4}`, B],
    ['rule 4: Task', tool('Task', { subagent_type: ADV, prompt: 'x' }), `deny: ${RULE4}`, B],
    ['rule 4: another agent passes', tool('Agent', { subagent_type: 'general-purpose', prompt: 'x' }), '', B],

    // Rule 5: lookalike or unpinned runners.
    ...['npx rough-ride quick', 'npx rough-ride@latest quick', 'npx rough-ride@^0.4.0 quick', 'pnpm dlx Rough_Ride@0.4.0', 'bunx @roughride/cli', 'npm exec rough-ride quick', 'yarn dlx rough.ride@0.4.0', 'bun x rough-ride', 'npx -p rough-ride rough-ride quick']
      .map((c) => [`rule 5: ${c}`, bash(c), `deny: ${RULE5(VERSION)}`, B]),
    ...['npx -y rough-ride@0.4.0 quick', 'npx --no rough-ride quick', 'npx --no -- rough-ride --version', 'npx prettier --check .', 'pnpm dlx rough-ride@1.2.3-rc.1']
      .map((c) => [`rule 5: ${c} passes`, bash(c), '', B]),

    // Rule 6: the skills take no arguments.
    ['rule 6: rough-ride:quick with arguments', tool('Skill', { skill: 'rough-ride:quick', args: 'focus on login' }), `deny: ${RULE6}`, B],
    ['rule 6: rough-ride:quick alone passes', tool('Skill', { skill: 'rough-ride:quick' }), '', B],
    ['rule 6: blank arguments pass', tool('Skill', { skill: 'rough-ride:quick', args: '  ' }), '', B],
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
    ['rule 7: a body naming .rough-ride is rule 2', bash(cli(`link --run ${RUN}`, { body: '- {file: .rough-ride/x}\n' }), adv), `deny: ${RULE2}`, B],
    ['rule 7: a bad run id', bash(cli('snapshot --run 2026-x'), adv), `deny: ${RULE7}`, B],
    ['rule 7: a bad flow name', bash(cli(`flow save Bad_Name --run ${RUN}`), adv), `deny: ${RULE7}`, B],
    ['rule 7: git status', bash('git status', adv), `deny: ${RULE7}`, B],
    ['rule 7: PowerShell', tool('PowerShell', { command: cli('plan quick') }, adv), `deny: ${RULE7}`, B],
    ['rule 7: an MCP call', tool('mcp__chrome-devtools__navigate_page', { url: 'http://localhost:3000' }, adv), `deny: ${RULE7}`, B],
    ['rule 7: Edit to the folder is still rule 1', tool('Write', { file_path: path.join(repo, '.rough-ride', 'flows', 'x.yaml') }, adv), `deny: ${RULE1}`, B],
  ];

  // For case-insensitive file systems only.
  const CASE_ROWS = [
    ['rule 7: the plugin root in other letter case', bash(cli('plan quick', { root: other(pkg) }), adv), 'allow', B],
    ['rule 7: the data folder in other letter case', bash(cli('plan quick', { folder: other(data) }), adv), 'allow', B],
  ];

  // Handler C: [name, stdin, expected verdict for the adversary]. Without the
  // adversary's agent_type every one of them prints nothing.
  const transcriptDir = path.join(scratchDir(), 'projects', '-repo');
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = path.join(transcriptDir, 's1.jsonl');
  const runs = path.join(repo, '.rough-ride', 'runs', RUN);
  const read = (file_path, extra) => tool('Read', { file_path }, { transcript_path: transcript, ...extra });
  const READ_ROWS = [
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
    ['a flow file', read(path.join(repo, '.rough-ride', 'flows', 'x.yaml')), ''],
    ['another projects folder', read(path.join(scratchDir(), 'projects', 'x', 'y.ts')), ''],
    ['Grep over runs/', tool('Grep', { pattern: 'x', path: '.rough-ride/runs' }, {}), `deny: ${READ}`],
    ['Grep with a .env glob', tool('Grep', { pattern: 'x', glob: '**/.env' }, {}), `deny: ${READ}`],
    ['Glob into another run', tool('Glob', { pattern: `.rough-ride/runs/${RUN}/*.txt` }, {}), `deny: ${READ}`],
    ['Glob into the adversary folder', tool('Glob', { pattern: `.rough-ride/runs/${RUN}/adversary/*.json` }, {}), ''],
    ['Grep over the source', tool('Grep', { pattern: 'x', path: 'frontend' }, {}), ''],
  ];

  // The SubagentStop check: the runner's summary block and session file.
  const BLOCK = `--- rough-ride summary (copy this block unchanged) ---\nrough-ride plan | 2s | run ${RUN}\nFull report: /x/report.txt\n--- end of rough-ride summary ---\n`;
  const sessionFile = (sessionId) => path.join(data, 'adversary-runs', `${sessionId}.json`);
  function record(sessionId, fields) {
    mkdirSync(path.join(data, 'adversary-runs'), { recursive: true });
    const summary = fields.summary ?? BLOCK;
    const value = {
      run: RUN,
      attacked: false,
      summary,
      summarySha256: createHash('sha256').update(summary).digest('hex'),
      cli: path.join(pkg, 'dist', 'cli.mjs'),
      pluginData: data,
      summaryPath: path.join(repo, '.rough-ride', 'runs', RUN, 'adversary', 'summary.txt'),
      ...fields,
    };
    writeFileSync(sessionFile(sessionId), JSON.stringify(value));
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

  return { VERSION, repo, projectDir, data, B, adv, tool, bash, cli, ROWS, CASE_ROWS, READ_ROWS, BLOCK, sessionFile, record, stopInput };
}

// ---- The session-start hook ----

export const FLOOR = (v) =>
  `rough-ride ${v} needs Claude Code 2.1.299 or later; this session runs 2.1.250. Older versions let a failed edit-blocking hook through. Update with claude update, restart Claude Code, then run /rough-ride:quick again.`;
export const DUPLICATE =
  "rough-ride is installed twice: rough-ride@rough-ride 0.9.3 and rough-ride@claude-plugins-official 1.0.0. Only one copy's hooks run, and each copy keeps its own data folder. Remove one: /plugin uninstall rough-ride@rough-ride";
export const INLINE = (root) => `rough-ride is loaded from ${root.replace(/[\\/]$/, '')} for this session (--plugin-dir) and replaces the installed copy.`;
export const PACKAGES = (id) =>
  `rough-ride's packages are not installed: Claude Code's install of them did not finish (60-second limit). Run in your shell: claude plugin update ${id}`;
export const OLD_NODE = (version, execPath) => `rough-ride's hooks run on Node ${version} (${execPath}); the runner needs 22.22 or later.`;

// A plugins root with a copy of the package in `pkg` installed under `ids`, as
// Claude Code lays it out. Returns the paths a hook sees: `root` and `data`
// are the first copy's.
export function pluginsHome(pkg, { ids = [], withPackages = true } = {}) {
  const home = scratchDir();
  const plugins = path.join(home, 'plugins');
  const records = {};
  let first = null;
  for (const [id, version] of ids) {
    const [plugin, marketplace] = id.split('@');
    const dir = path.join(plugins, 'cache', marketplace, plugin, version);
    mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'rough-ride', version }));
    cpSync(path.join(pkg, 'hooks'), path.join(dir, 'hooks'), { recursive: true });
    cpSync(path.join(pkg, 'package.json'), path.join(dir, 'package.json'));
    if (withPackages) {
      mkdirSync(path.join(dir, 'node_modules', 'playwright-core'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', 'playwright-core', 'package.json'), '{"version":"1.64.1"}');
    }
    records[id] = [{ scope: 'user', installPath: dir, version }];
    first ??= { root: dir, data: path.join(plugins, 'data', `${plugin}-${marketplace}`) };
  }
  mkdirSync(plugins, { recursive: true });
  writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: records }));
  return { home, plugins, data: path.join(plugins, 'data', 'rough-ride-rough-ride'), ...first };
}
