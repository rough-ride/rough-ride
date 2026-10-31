// The edit guard hook (spec part 6 section 28, part 11 section 46). One script
// serves every handler, chosen by its arguments:
//   (none)                      handler A: file-tool writes under .rough-ride/
//   <plugin data>               handler B: rules 1 to 7
//   read                        handler C: what the adversary may read
//   stop <plugin data>          the SubagentStop check
// Hand-written, not tsc output: Node 18 syntax and APIs only, no dependencies.
// It never calls git and never reads the network. It always exits 0, with a
// decision on stdout or with nothing; it only slows edits, and the runner's
// reviewed-version rules and checksum manifest are what catch them.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, checkPath, couldBeInside, fold, isFolderName, samePath } from './path-check.mjs';
import { ownVersion, validSession } from './plugin-checks.mjs';

const ADVERSARY = 'rough-ride:adversary';
const RULE1 =
  'Files under .rough-ride/ are changed only by rough-ride and by people. Read them with the Read tool, and tell the user what you wanted to change.';
const RULE2 = 'Commands that name .rough-ride/ are blocked. Read its files with the Read tool; stage them with git add.';
const RULE3 =
  "flow save, link and attack --plan are run only by rough-ride:adversary, which /rough-ride:quick and /rough-ride:standard start. Run one of those skills instead.";
const RULE4 =
  'rough-ride:adversary is started only by /rough-ride:quick and /rough-ride:standard. Run one of those skills, with nothing after the name.';
const RULE6 =
  "rough-ride's /rough-ride:quick and /rough-ride:standard take no arguments. Run them with nothing after the name; for another tool's quick skill, use its full name.";
const RULE7 =
  "rough-ride:adversary runs only rough-ride's own commands, typed from the prefix in its instructions. Put anything else in your notes.";
const READ_REASON =
  "rough-ride:adversary doesn't read Claude Code's files, instruction files, secrets or other run output. Work from the repository and your run's adversary folder.";

const RUN_ID = /^\d{8}-\d{6}-[a-z]+-[a-z0-9]{4}$/;
const FLOW_NAME = /^[a-z0-9][a-z0-9-]{0,47}(:[a-z]{1,2}[0-9]{1,4})?$/;
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const GIT_EXCEPTION = /^\s*git\s+(add|diff|log|show|status|ls-files)(\s[^;&|<>$`()\r\n]*)?$/;
const HEREDOC = " <<'RP_END'";
// Outside the heredoc body, rule 7's command holds none of these.
const SHELL_CHARS = /[;&|<>`$(){}\r\n]/;

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readStdin() {
  try {
    const value = JSON.parse(fs.readFileSync(0, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function attempt(fn, fallback) {
  try {
    return fn();
  } catch (_) {
    return fallback;
  }
}

function decide(decision, reason) {
  const out = { hookEventName: 'PreToolUse', permissionDecision: decision };
  if (reason) out.permissionDecisionReason = reason;
  return { hookSpecificOutput: out };
}

const deny = (reason) => decide('deny', reason);

// ---- Rule 1: file tools and MCP tools ----

function pathFields(value, key, out) {
  if (typeof value === 'string') {
    if (key !== null && (/path$/i.test(key) || /^(file|filename)$/i.test(key))) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) pathFields(item, key, out);
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) pathFields(value[k], k, out);
  }
  return out;
}

function rule1(tool, toolInput, cwd) {
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    for (const p of [toolInput.file_path, toolInput.notebook_path]) {
      if (typeof p === 'string' && checkPath(p, cwd).blocked) return deny(RULE1);
    }
    return null;
  }
  if (!tool.startsWith('mcp__')) return null;
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  for (const p of pathFields(toolInput, null, [])) {
    const bases = path.isAbsolute(p) ? [cwd] : [cwd, ...(projectDir ? [projectDir] : [])];
    for (const base of bases) if (checkPath(p, base).blocked) return deny(RULE1);
  }
  return null;
}

// ---- Shell commands: rules 2, 3 and 5 ----

function names(command) {
  const lower = command.toLowerCase().replace(/\\/g, '/');
  return lower.includes('.rough-ride') || /rough-~\d/.test(lower);
}

function rule2(command) {
  if (!names(command)) return null;
  if (GIT_EXCEPTION.test(command) && !/--output|--ext-diff/i.test(command)) return null;
  return deny(RULE2);
}

// The simple commands in a shell line, each as words with their quotes taken
// off. A rough split, for a speed bump: quoted operators split too.
function simpleCommands(command) {
  return command
    .split(/[;&|\n()]+/)
    .map((part) => part.split(/\s+/).map((w) => w.replace(/^["']+|["']+$/g, '')).filter((w) => w !== ''))
    .filter((words) => words.length > 0);
}

// A package spec's name and scope, folded: version dropped, `-`, `_` and `.`
// removed, lower-cased.
function foldsToRoughRide(spec) {
  let name = spec;
  let scope = null;
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    scope = slash === -1 ? name.slice(1) : name.slice(1, slash);
    name = slash === -1 ? '' : name.slice(slash + 1);
  }
  const at = name.indexOf('@');
  if (at !== -1) name = name.slice(0, at);
  const f = (s) => s.replace(/[-_.]/g, '').toLowerCase();
  if (scope !== null) scope = f(scope.split('@')[0]);
  return f(name) === 'roughride' || scope === 'roughride';
}

function isRunnerWord(word) {
  return /cli\.mjs$/i.test(word) || word === '--run' || word === '--plugin-data' || (!word.startsWith('-') && foldsToRoughRide(word));
}

function rule3(command) {
  for (const words of simpleCommands(command.toLowerCase())) {
    for (let i = 0; i < words.length; i++) {
      if (words[i] === 'flow' && words[i + 1] === 'save') return deny(RULE3);
    }
    if (words.includes('attack') && words.some((w) => w === '--plan' || w.startsWith('--plan='))) return deny(RULE3);
    if (words.includes('link') && words.some(isRunnerWord)) return deny(RULE3);
  }
  return null;
}

// Where the package arguments start for each package runner, or -1.
function runnerAt(words, i) {
  const w = words[i];
  const next = words[i + 1];
  if (w === 'npx' || w === 'pnpx' || w === 'bunx') return i + 1;
  if (w === 'npm' && (next === 'exec' || next === 'x')) return i + 2;
  if ((w === 'pnpm' || w === 'yarn') && next === 'dlx') return i + 2;
  if (w === 'bun' && next === 'x') return i + 2;
  return -1;
}

// The package specs a runner call names: --package values and the first
// positional word. `-c` and `--call` strings are checked as commands.
function packageSpecs(words, start) {
  const specs = [];
  const calls = [];
  let noInstall = false;
  for (let i = start; i < words.length; i++) {
    const w = words[i];
    if (w === '--') {
      if (words[i + 1] !== undefined) specs.push(words[i + 1]);
      break;
    }
    if (w === '--no') noInstall = true;
    if (w === '-p' || w === '--package') {
      if (words[i + 1] !== undefined) specs.push(words[++i]);
    } else if (w.startsWith('--package=')) {
      specs.push(w.slice('--package='.length));
    } else if (w === '-c' || w === '--call') {
      if (words[i + 1] !== undefined) calls.push(words[++i]);
    } else if (!w.startsWith('-')) {
      specs.push(w);
      break;
    }
  }
  return { specs, calls, noInstall };
}

function rule5(command) {
  for (const words of simpleCommands(command)) {
    for (let i = 0; i < words.length; i++) {
      const start = runnerAt(words, i);
      if (start === -1) continue;
      const { specs, calls, noInstall } = packageSpecs(words, start);
      for (const spec of specs) {
        if (!foldsToRoughRide(spec)) continue;
        const pinned = spec.startsWith('rough-ride@') && EXACT_SEMVER.test(spec.slice('rough-ride@'.length));
        const ownInstall = words[i] === 'npx' && noInstall && spec === 'rough-ride';
        if (!pinned && !ownInstall) return deny(rule5Reason());
      }
      for (const call of calls) {
        const found = rule5(call);
        if (found) return found;
      }
    }
  }
  return null;
}

function rule5Reason() {
  const version = attempt(() => ownVersion(pluginRoot), null) || '<version>';
  return (
    `rough-ride runs only from its exact version or the project's own install: npx -y rough-ride@${version} quick, ` +
    'or npx --no rough-ride quick. Unpinned versions and lookalike names are blocked.'
  );
}

// ---- Rule 7: the adversary runs only the runner ----

function samePlace(given, own, platform) {
  const mod = platform === 'win32' ? path.win32 : path.posix;
  return mod.isAbsolute(given) && attempt(() => samePath(given, own, platform), false);
}

function argsMatch(words) {
  const sub = words[0];
  const runAt = (i) => words[i] === '--run' && RUN_ID.test(words[i + 1] || '');
  if (sub === 'plan') return words.length === 2 && (words[1] === 'quick' || words[1] === 'standard');
  if (sub === 'snapshot' || sub === 'link') return words.length === 3 && runAt(1);
  if (sub === 'flow') {
    if (words[1] !== 'save' || words.length < 5 || !runAt(words.length - 2)) return false;
    const flowNames = words.slice(2, words.length - 2);
    return flowNames.every((n) => FLOW_NAME.test(n));
  }
  if (sub === 'attack') {
    if (!runAt(1)) return false;
    const seen = new Set();
    for (let i = 3; i < words.length; i++) {
      const flag = words[i] === '--plan' && words[i + 1] === '-' ? '--plan' : words[i] === '--check' ? '--check' : null;
      if (flag === null || seen.has(flag)) return false;
      seen.add(flag);
      if (flag === '--plan') i++;
    }
    return true;
  }
  return false;
}

// True when `command` is exactly
//   node "<P>/dist/cli.mjs" <sub> <args> --plugin-data "<D>"
// optionally followed by ` <<'RP_END'`, a newline, a body and a last line RP_END.
function runnerCall(command, pluginData) {
  if (!pluginData) return false;
  const newline = command.indexOf('\n');
  let line = newline === -1 ? command : command.slice(0, newline);
  if (line.endsWith(HEREDOC)) {
    if (newline === -1) return false;
    line = line.slice(0, -HEREDOC.length);
    const rest = command.slice(newline + 1).replace(/\n$/, '');
    const lines = rest.split('\n');
    if (lines[lines.length - 1] !== 'RP_END') return false;
    if (lines.slice(0, -1).some((l) => l.trim() === 'RP_END')) return false;
  } else if (newline !== -1) {
    return false;
  }
  if (SHELL_CHARS.test(line)) return false;
  const m = /^node "([^"]+)[\\/]dist[\\/]cli\.mjs" ([^"]+) --plugin-data "([^"]+)"$/.exec(line);
  if (!m || m[3].endsWith('\\')) return false;
  const words = m[2].split(' ');
  if (words.some((w) => w === '') || !argsMatch(words)) return false;
  return samePlace(m[1], pluginRoot, process.platform) && samePlace(m[3], pluginData, process.platform);
}

function rule7(tool, toolInput, pluginData) {
  if (tool === 'PowerShell' || tool.startsWith('mcp__')) return deny(RULE7);
  if (tool !== 'Bash') return null;
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  return runnerCall(command, pluginData) ? decide('allow') : deny(RULE7);
}

// ---- Rules 4 and 6 ----

function rule4(tool, toolInput) {
  if (tool !== 'Agent' && tool !== 'Task') return null;
  const type = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type.trim().toLowerCase() : '';
  return type === ADVERSARY ? deny(RULE4) : null;
}

function hasText(value) {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasText);
  if (value && typeof value === 'object') return Object.values(value).some(hasText);
  return false;
}

function rule6(tool, toolInput) {
  if (tool !== 'Skill') return null;
  const skill = typeof toolInput.skill === 'string' ? toolInput.skill.trim().replace(/^\//, '').toLowerCase() : '';
  if (!['rough-ride:quick', 'rough-ride:standard', 'quick', 'standard'].includes(skill)) return null;
  const others = Object.keys(toolInput).filter((k) => k !== 'skill');
  return others.some((k) => hasText(toolInput[k])) ? deny(RULE6) : null;
}

// ---- Handlers A and B ----

function preToolUse(input, pluginData) {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const adversary = input.agent_type === ADVERSARY;

  const first = rule1(tool, toolInput, cwd) || rule4(tool, toolInput) || rule6(tool, toolInput);
  if (first) return first;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    const named = rule2(command);
    if (named) return named;
    if (adversary) return rule7(tool, toolInput, pluginData);
    return rule3(command) || rule5(command);
  }
  if (adversary) return rule7(tool, toolInput, pluginData);
  return null;
}

// ---- Handler C ----

const DENIED_FOLDERS = new Set(['.claude', '.git', '.ssh', '.aws']);
const DENIED_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', '.npmrc', '.netrc']);

function deniedSegments(segments) {
  const folded = segments.map(fold);
  if (folded.some((s) => DENIED_FOLDERS.has(s))) return true;
  const base = folded[folded.length - 1] || '';
  if (DENIED_FILES.has(base) || base === '.env' || base.startsWith('.env.') || base.endsWith('.pem') || base.endsWith('.key')) return true;
  for (let i = 0; i < segments.length; i++) {
    if (isFolderName(segments[i]) && folded[i + 1] === 'runs') return folded[i + 3] !== 'adversary';
  }
  return false;
}

function readDenied(p, cwd, transcriptDir) {
  const given = p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
  const lexical = path.resolve(cwd, given);
  const forms = [lexical, attempt(() => canon(lexical), null)].filter(Boolean).map((f) => f.replace(/\\/g, '/'));
  if (forms.some((form) => deniedSegments(form.split('/').filter((s) => s !== '')))) return true;
  return transcriptDir !== null && couldBeInside(lexical, transcriptDir);
}

function readGuard(input) {
  if (input.agent_type !== ADVERSARY) return null;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const transcriptDir = typeof input.transcript_path === 'string' && input.transcript_path !== '' ? path.dirname(input.transcript_path) : null;
  const paths = [];
  if (input.tool_name === 'Read') {
    if (typeof toolInput.file_path === 'string') paths.push(toolInput.file_path);
  } else if (input.tool_name === 'Grep' || input.tool_name === 'Glob') {
    // The search root, and the glob read as a path under it.
    const root = typeof toolInput.path === 'string' && toolInput.path !== '' ? toolInput.path : '.';
    paths.push(root);
    const pattern = input.tool_name === 'Glob' ? toolInput.pattern : toolInput.glob;
    if (typeof pattern === 'string' && pattern !== '') paths.push(path.join(root, pattern));
  } else {
    return null;
  }
  return paths.some((p) => readDenied(p, cwd, transcriptDir)) ? deny(READ_REASON) : null;
}

// ---- The SubagentStop check ----

function sessionFile(pluginData, sessionId) {
  return path.join(pluginData, 'adversary-runs', `${sessionId}.json`);
}

function readRecord(file) {
  const record = attempt(() => JSON.parse(fs.readFileSync(file, 'utf8')), null);
  if (!record || typeof record !== 'object' || typeof record.summary !== 'string') return null;
  const sha = createHash('sha256').update(record.summary, 'utf8').digest('hex');
  if (typeof record.summarySha256 !== 'string' || record.summarySha256.toLowerCase() !== sha) return null;
  if (record.run !== null && !(typeof record.run === 'string' && RUN_ID.test(record.run))) return null;
  return record;
}

const crlf = (s) => s.replace(/\r\n/g, '\n');

function subagentStop(input, pluginData) {
  if (input.agent_type !== undefined && input.agent_type !== ADVERSARY) return null;
  if (!pluginData || !validSession(input.session_id)) return null;
  const file = sessionFile(pluginData, input.session_id);
  const record = readRecord(file);
  if (record === null) return null;

  const run = record.run;
  // The skills' own prefix, `${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs`, which rule 7 accepts.
  const ownCli = `${pluginRoot}/dist/cli.mjs`;
  const cli = typeof record.cli === 'string' && record.cli !== '' ? record.cli : ownCli;
  const folder = typeof record.pluginData === 'string' && record.pluginData !== '' ? record.pluginData : pluginData;
  const summaryPath = typeof record.summaryPath === 'string' && record.summaryPath !== '' ? record.summaryPath : file;
  const notAttacked = run !== null && record.attacked !== true;
  const message = input.last_assistant_message;
  const missing = typeof message === 'string' && !crlf(message).includes(crlf(record.summary).replace(/\n$/, ''));

  if (input.stop_hook_active === true) {
    if (notAttacked) {
      return {
        systemMessage:
          `rough-ride: the adversary stopped before attacking run ${run}, so nothing was attacked. ` +
          `To run the selected attacks with nothing added: node "${cli}" attack --run ${run} --plugin-data "${folder}"`,
      };
    }
    if (missing) {
      const what = run === null ? "the runner's summary" : `the runner's summary for run ${run}`;
      return { systemMessage: `rough-ride: the adversary's report left out ${what}: ${summaryPath}` };
    }
    return null;
  }
  if (notAttacked) {
    return { decision: 'block', reason: `Run node "${ownCli}" attack --run ${run} --plugin-data "${pluginData}" before you finish.` };
  }
  if (missing) {
    return { decision: 'block', reason: `Your final message must contain the runner's summary block from ${summaryPath} exactly.` };
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const input = readStdin();
  let out = null;
  if (args[0] === 'read') out = readGuard(input);
  else if (args[0] === 'stop') out = subagentStop(input, args[1] || null);
  else out = preToolUse(input, args[0] || null);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // A hook never fails the session.
}
process.exitCode = 0;
