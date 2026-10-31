// Which copy of the runner is running, and how to print commands that run it
// again (part 1 sections 4 and 5).

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release as osRelease } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SourceKind = 'plugin' | 'devDependency' | 'npx' | 'other';

export interface RunnerSource {
  kind: SourceKind;
  // plugin: its id; devDependency: the package.json path; other: the cli path.
  detail: string | null;
  // A lockfile `resolved` that isn't the registry tarball, else null.
  resolved: string | null;
}

export interface RunnerInfo {
  version: string;
  cliPath: string;
  source: RunnerSource;
  pluginId: string | null;
  pluginData: { path: string; verified: boolean } | null;
  node: string;
  playwright: string | null;
  claudeCode: { version: string | null; floorChecked: boolean };
  editGuard: 'on' | 'off' | 'n/a';
  // Set once the committed files are read; summary.json carries it on its own.
  versionSkew: VersionSkew | null;
}

export interface VersionSkew {
  pin: string;
  file: string;
  ciWillStop: boolean;
  line: string;
}

export const CLAUDE_FLOOR = '2.1.299';
export const EDIT_GUARD_OFF =
  'Edit guard: not running in this session. rough-ride\'s hooks did not start (hooks turned off by settings or policy,' +
  ' another copy holds the name, or node is missing for hooks), so edits under .rough-ride/ are not blocked.';

const REGISTRY_TARBALL = /^https:\/\/registry\.npmjs\.org\/rough-ride\/-\/rough-ride-[^/]+\.tgz$/;

export function ownVersion(): string {
  const pkg = new URL('../package.json', import.meta.url);
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}

export function playwrightVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const file = require.resolve('playwright-core/package.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
  } catch {
    return null;
  }
}

export function claudeCodeVersion(env: NodeJS.ProcessEnv): string | null {
  const agent = /^claude-code_(\d+)-(\d+)-(\d+)/.exec(env.AI_AGENT ?? '');
  if (agent) return `${agent[1]}.${agent[2]}.${agent[3]}`;
  const last = path.basename(env.CLAUDE_CODE_EXECPATH ?? '');
  return /^\d+\.\d+\.\d+$/.test(last) ? last : null;
}

function slashes(p: string): string {
  return p.split(path.sep).join('/');
}

// Repo-relative when the path sits inside a git work tree, else absolute.
function displayPath(file: string, cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) {
      const rel = path.relative(dir, file);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return slashes(rel);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return slashes(file);
}

function lockfileResolved(projectDir: string): string | null {
  try {
    const lock = JSON.parse(readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { resolved?: string }>;
    };
    const resolved = lock.packages?.['node_modules/rough-ride']?.resolved;
    return resolved && !REGISTRY_TARBALL.test(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function detectSource(cliPath: string, pluginData: string | null, cwd: string): RunnerSource {
  const parts = cliPath.split(/[\\/]/);
  if (pluginData !== null) {
    // Claude Code installs plugins at <...>/plugins/cache/<marketplace>/<plugin>/<version>/.
    const cache = parts.lastIndexOf('cache');
    const marketplace = parts[cache + 1];
    const plugin = parts[cache + 2];
    const id = cache > 0 && parts[cache - 1] === 'plugins' && marketplace && plugin
      ? `${plugin}@${marketplace}`
      : 'rough-ride';
    return { kind: 'plugin', detail: id, resolved: null };
  }
  const nm = parts.lastIndexOf('node_modules');
  if (nm > 0 && parts[nm + 1] === 'rough-ride') {
    if (parts.includes('_npx')) return { kind: 'npx', detail: null, resolved: null };
    const projectDir = parts.slice(0, nm).join(path.sep) || path.sep;
    return {
      kind: 'devDependency',
      detail: displayPath(path.join(projectDir, 'package.json'), cwd),
      resolved: lockfileResolved(projectDir),
    };
  }
  return { kind: 'other', detail: slashes(cliPath), resolved: null };
}

// A cache copy's data folder: <plugins root>/data/<plugin>-<marketplace>/,
// every character outside [A-Za-z0-9_-] made '-', with forward slashes like
// every other path the runner prints. Null for an in-place load.
export function derivedPluginData(cliPath: string): string | null {
  const parts = cliPath.split(/[\\/]/);
  const cache = parts.lastIndexOf('cache');
  const marketplace = parts[cache + 1];
  const plugin = parts[cache + 2];
  if (cache <= 0 || parts[cache - 1] !== 'plugins' || !marketplace || !plugin || parts.length < cache + 5) return null;
  const name = `${plugin}-${marketplace}`.replace(/[^A-Za-z0-9_-]/g, '-');
  return [...parts.slice(0, cache), 'data', name].join('/') || '/';
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    let real = p;
    try {
      real = realpathSync.native(p);
    } catch {
      // A folder not created yet compares as written.
    }
    const s = real.split(/[\\/]+/).join('/').replace(/\/$/, '');
    return platform === 'darwin' || platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

// The stop line when --plugin-data names another folder than this cache
// copy's (spec part 1 section 4), else null.
export function pluginDataMismatch(info: RunnerInfo, platform: NodeJS.Platform = process.platform): string | null {
  if (info.pluginData === null) return null;
  const derived = derivedPluginData(info.cliPath);
  if (derived === null || samePath(info.pluginData.path, derived, platform)) return null;
  return `rough-ride: --plugin-data ${info.pluginData.path} is not this plugin copy's data folder (${derived}). Run the plugin's skills instead of typing this command.`;
}

export function claudeFloorStop(info: RunnerInfo, tier: string): string | null {
  const version = info.claudeCode.version;
  if (info.pluginData === null || version === null || compareSemver(version, CLAUDE_FLOOR) >= 0) return null;
  return `rough-ride ${info.version} needs Claude Code ${CLAUDE_FLOOR} or later; this session runs ${version}.` +
    ` Older versions let a failed edit-blocking hook through. Update with claude update, restart Claude Code, then run /rough-ride:${tier} again.`;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function editGuardOf(pluginData: string | null, env: NodeJS.ProcessEnv): 'on' | 'off' | 'n/a' {
  if (pluginData === null) return 'n/a';
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (!session || !/^[A-Za-z0-9_-]+$/.test(session)) return 'off';
  return existsSync(path.join(pluginData, 'sessions', session)) ? 'on' : 'off';
}

export function runnerInfo(pluginData: string | null, cwd: string, env: NodeJS.ProcessEnv): RunnerInfo {
  const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const source = detectSource(cliPath, pluginData, cwd);
  const claude = pluginData === null ? null : claudeCodeVersion(env);
  const derived = derivedPluginData(cliPath);
  return {
    version: ownVersion(),
    cliPath,
    source,
    pluginId: source.kind === 'plugin' ? source.detail : null,
    pluginData: pluginData === null ? null : { path: pluginData, verified: derived !== null && samePath(pluginData, derived, process.platform) },
    node: process.versions.node,
    playwright: playwrightVersion(),
    claudeCode: { version: claude, floorChecked: claude !== null },
    editGuard: editGuardOf(pluginData, env),
    versionSkew: null,
  };
}

export function versionLine(info: RunnerInfo): string {
  return `rough-ride ${info.version} | Playwright ${info.playwright ?? 'missing'} | Node ${info.node}`;
}

// `devDependency frontend/package.json`, `plugin rough-ride@rough-ride`, `npx`, `other <path>`.
export function sourceText(info: RunnerInfo): string {
  const { source } = info;
  if (source.kind === 'npx') return 'npx';
  return `${source.kind} ${source.detail}`;
}

export function runnerLine(info: RunnerInfo): string {
  let from = sourceText(info);
  if (info.source.resolved) from += ` (resolved ${info.source.resolved}, not the npm registry)`;
  const parts = [`Runner: rough-ride ${info.version} from ${from}`, `Node ${info.node}`];
  parts.push(`Playwright ${info.playwright ?? 'missing'}`);
  // Outside a session there is no Claude Code to report; inside one an unread
  // version is said out loud.
  if (info.claudeCode.version) parts.push(`Claude Code ${info.claudeCode.version}`);
  else if (info.source.kind === 'plugin') parts.push(`Claude Code: unknown (floor ${CLAUDE_FLOOR} not checked)`);
  if (info.pluginData && !info.pluginData.verified) parts.push(`plugin data: ${slashes(info.pluginData.path)} (from --plugin-data, not verified)`);
  return parts.join(' | ');
}

// The runner block: the runner line, then the edit-guard line when the guard
// is off, then the version skew line when it applies (spec part 9 section 37).
export function runnerBlock(info: RunnerInfo): string[] {
  const lines = [runnerLine(info)];
  if (info.editGuard === 'off') lines.push(EDIT_GUARD_OFF);
  if (info.versionSkew) lines.push(info.versionSkew.line);
  return lines;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const EXACT = /^[0-9]+\.[0-9]+\.[0-9]+$/;

// The version skew line (spec part 1 section 5). `dirs` are the package.json
// folders in lookup order, repo-relative ('' for the git root); `written` are
// the committed files this invocation read, with their schema.
export function versionSkew(
  info: RunnerInfo,
  root: string,
  dirs: string[],
  written: { shown: string; schema: string }[],
  argv: string[],
): VersionSkew | null {
  for (const dir of dirs) {
    const pkg = readJson(path.join(root, dir, 'package.json')) as PackageJson | null;
    const spec = pkg?.devDependencies?.['rough-ride'] ?? pkg?.dependencies?.['rough-ride'];
    if (typeof spec !== 'string') continue;
    const installed = (readJson(path.join(root, dir, 'node_modules', 'rough-ride', 'package.json')) as { version?: unknown } | null)?.version;
    const pin = typeof installed === 'string' ? installed : spec;
    const bare = pin.replace(/^[\^~=v>\s]+/, '');
    if (!EXACT.test(bare) || bare === info.version) return null;
    const file = `${dir ? dir.replace(/\/$/, '') + '/' : ''}package.json`;
    const exact = typeof installed === 'string' || EXACT.test(spec);
    const above = written.filter((w) => compareSemver(w.schema, bare) > 0).sort((a, b) => compareSemver(b.schema, a.schema) || a.shown.localeCompare(b.shown));
    const ciWillStop = exact && above.length > 0;
    const from = info.source.kind === 'plugin' ? 'the plugin' : sourceText(info);
    let line = `Version skew: this run used rough-ride ${info.version} from ${from}; ${file} pins ${pin}, which CI runs.`;
    if (ciWillStop) {
      const n = above.length;
      const shown = n === 1 ? above[0]!.shown : `${above[0]!.shown} and ${n - 1} more`;
      line += ` CI will stop: ${bare} can't read ${n === 1 ? '1 file' : `${n} files`} written for ${above[0]!.schema} (${shown}).`;
    }
    const align = compareSemver(bare, info.version) < 0
      ? `npm i -D -E rough-ride@${info.version}${dir ? ` in ${dir.replace(/\/$/, '')}/` : ''}`
      : updateCommand(info, bare, argv);
    line += ` Align them: ${align}`;
    return { pin, file, ciWillStop, line };
  }
  return null;
}

// GITHUB_ACTIONS=true, or CI set to anything but false or 0.
export function isCi(env: NodeJS.ProcessEnv): boolean {
  return env.GITHUB_ACTIONS === 'true' || (env.CI !== undefined && env.CI !== 'false' && env.CI !== '0');
}

// CI mode (52.1): CI with no plugin data folder, so a skill invocation never is.
export function ciMode(env: NodeJS.ProcessEnv, info: RunnerInfo): boolean {
  return isCi(env) && !info.pluginData;
}

// record.json's environment (ticket 16 item 19).
export function environmentRecord(env: NodeJS.ProcessEnv, info: RunnerInfo) {
  return { os: { platform: process.platform, release: osRelease(), arch: process.arch }, ci: isCi(env), mode: info.pluginData ? 'session' : ciMode(env, info) ? 'ci' : 'terminal' };
}

const TIERS = new Set(['quick', 'standard']);

// Follow-up commands use the form that ran the runner, because the reader
// (often an agent) pastes them as they are.
export function followUpCommand(info: RunnerInfo, args: string[]): string {
  const rest = args.join(' ');
  switch (info.source.kind) {
    case 'plugin':
      if (args.length === 1 && TIERS.has(args[0]!)) return `/rough-ride:${args[0]}`;
      return `node "${slashes(info.cliPath)}" ${rest} --plugin-data "${slashes(info.pluginData!.path)}"`;
    case 'devDependency':
      return `npx --no rough-ride ${rest}`;
    case 'npx':
      return `npx -y rough-ride@${info.version} ${rest}`;
    case 'other':
      return `node "${slashes(info.cliPath)}" ${rest}`;
  }
}

// The command that gets this copy of the runner to `version` (spec part 2
// section 7.8): it follows the runner's source.
export function updateCommand(info: RunnerInfo, version: string, argv: string[]): string {
  switch (info.source.kind) {
    case 'devDependency': {
      const folder = path.posix.dirname(info.source.detail ?? 'package.json');
      return `npm i -D -E rough-ride@${version}${folder === '.' ? '' : ` in ${folder}/`}`;
    }
    case 'plugin': {
      const marketplace = (info.pluginId ?? 'rough-ride').split('@')[1] ?? 'rough-ride';
      return `/plugin marketplace update ${marketplace}, then /plugin update ${info.pluginId ?? 'rough-ride@rough-ride'}`;
    }
    case 'npx':
      return `npx -y rough-ride@${version} ${argv.join(' ')}`;
    case 'other':
      return `Install rough-ride ${version} or later.`;
  }
}
