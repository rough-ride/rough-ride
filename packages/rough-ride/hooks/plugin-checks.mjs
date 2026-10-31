// Which plugin copy is running, and the checks on it (spec part 1 sections 4
// and 5): the session-start hook, the preflight, the guard and the runner all
// import it. Hand-written, not tsc output: Node 18 syntax and APIs only, no
// dependencies, because hooks run on whatever Node Claude Code finds. Every
// check returns null when its inputs are unreadable.

import fs from 'node:fs';
import path from 'node:path';
import { printed, samePath } from './path-check.mjs';

export const CLAUDE_FLOOR = '2.1.299';
export const NODE_FLOOR = '22.22.0';
export const EDIT_GUARD_OFF =
  "Edit guard: not running in this session. rough-ride's hooks did not start (hooks turned off by settings or policy," +
  ' another copy holds the name, or node is missing for hooks), so edits under .rough-ride/ are not blocked.';
const OFFICIAL = 'claude-plugins-official';
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

export function ownVersion(pluginRoot) {
  const pkg = readJson(path.join(pluginRoot, 'package.json'));
  return pkg && typeof pkg.version === 'string' ? pkg.version : null;
}

// Claude Code keeps a cache copy at <plugins root>/cache/<marketplace>/<plugin>/<version>/
// and its data folder at <plugins root>/data/<plugin>-<marketplace>/, every
// character outside [A-Za-z0-9_-] made '-'. `p` is the copy's root or a path
// inside it. Paths come back with forward slashes; null when `p` is not in a
// cache copy.
export function cacheCopy(p) {
  const parts = String(p).split(/[\\/]/);
  const cache = parts.lastIndexOf('cache');
  const marketplace = parts[cache + 1];
  const plugin = parts[cache + 2];
  if (cache <= 0 || parts[cache - 1] !== 'plugins' || !marketplace || !plugin || !parts[cache + 3]) return null;
  const pluginsRoot = parts.slice(0, cache).join('/');
  const name = `${plugin}-${marketplace}`.replace(/[^A-Za-z0-9_-]/g, '-');
  return { id: `${plugin}@${marketplace}`, pluginsRoot, dataFolder: `${pluginsRoot}/data/${name}` };
}

// This copy's id; 'rough-ride' for a copy outside the cache.
export function copyId(pluginRoot) {
  const copy = cacheCopy(path.resolve(pluginRoot));
  return copy ? copy.id : 'rough-ride';
}

export function claudeCodeVersion(env) {
  const agent = /^claude-code_(\d+)-(\d+)-(\d+)/.exec(env.AI_AGENT || '');
  if (agent) return `${agent[1]}.${agent[2]}.${agent[3]}`;
  const last = path.basename(env.CLAUDE_CODE_EXECPATH || '');
  return /^\d+\.\d+\.\d+$/.test(last) ? last : null;
}

// The stop when Claude Code is below the floor; `tier` names the skill to run again.
export function floorStop(own, claudeVersion, tier) {
  if (claudeVersion === null || compareSemver(claudeVersion, CLAUDE_FLOOR) >= 0) return null;
  return `rough-ride ${own} needs Claude Code ${CLAUDE_FLOOR} or later; this session runs ${claudeVersion}.` +
    ` Older versions let a failed edit-blocking hook through. Update with claude update, restart Claude Code, then run /rough-ride:${tier} again.`;
}

export function floorMessage(pluginRoot, env) {
  return floorStop(ownVersion(pluginRoot) || '', claudeCodeVersion(env), 'quick');
}

export function packagesMessage(pluginRoot) {
  if (fs.existsSync(path.join(pluginRoot, 'node_modules', 'playwright-core', 'package.json'))) return null;
  return "rough-ride's packages are not installed: Claude Code's install of them did not finish (60-second limit)." +
    ` Run in your shell: claude plugin update ${copyId(pluginRoot)}`;
}

export function nodeMessage(versions, execPath) {
  if (compareSemver(versions.node, NODE_FLOOR) >= 0) return null;
  return `rough-ride's hooks run on Node ${versions.node} (${execPath}); the runner needs 22.22 or later.`;
}

// The preflight runs on the Bash tool's Node, the one the runner gets, so it
// uses the runner's own wording.
export function runnerNodeMessage(versions, execPath) {
  if (compareSemver(versions.node, NODE_FLOOR) >= 0) return null;
  return `rough-ride needs Node.js 22.22.0 or later; this is Node ${versions.node} at ${execPath}.` +
    ' A per-project version manager (Volta, asdf, mise, fnm, nvm) may have picked it from this project\'s settings.' +
    ' Install Node 22.22 or later for this project and run again.';
}

// The settings files that can turn a plugin off, lowest precedence first.
function settingsFiles(pluginsRoot, cwd) {
  const files = [path.join(path.dirname(pluginsRoot), 'settings.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  return files;
}

function enabled(id, pluginsRoot, cwd) {
  let on = true;
  for (const file of settingsFiles(pluginsRoot, cwd)) {
    const settings = readJson(file);
    const value = settings && settings.enabledPlugins ? settings.enabledPlugins[id] : undefined;
    if (value === false) on = false;
    else if (value === true) on = true;
  }
  return on;
}

// The enabled install records of a plugin named rough-ride for this project:
// user scope, plus project or local scope whose project is `cwd`.
export function installedCopies(pluginsRoot, cwd) {
  const doc = readJson(path.join(pluginsRoot, 'installed_plugins.json'));
  if (!doc || typeof doc !== 'object') return null;
  const plugins = doc.plugins && typeof doc.plugins === 'object' ? doc.plugins : doc;
  const copies = [];
  for (const id of Object.keys(plugins)) {
    const records = Array.isArray(plugins[id]) ? plugins[id] : [plugins[id]];
    for (const record of records) {
      if (!record || typeof record.installPath !== 'string') continue;
      const scope = record.scope || 'user';
      if (scope !== 'user' && !(cwd && typeof record.projectPath === 'string' && samePath(record.projectPath, cwd))) continue;
      const manifest = readJson(path.join(record.installPath, '.claude-plugin', 'plugin.json'));
      if (!manifest || manifest.name !== 'rough-ride') continue;
      if (!enabled(id, pluginsRoot, cwd)) continue;
      const version = typeof record.version === 'string' ? record.version : manifest.version || '';
      copies.push({ id, version, installPath: record.installPath });
    }
  }
  return copies;
}

export function duplicateMessage(copies) {
  if (!copies || copies.length < 2) return null;
  const names = copies.map((c) => `${c.id} ${c.version}`);
  const listed = names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const others = copies.filter((c) => !c.id.endsWith('@' + OFFICIAL));
  const pool = others.length > 0 ? others : copies;
  const remove = pool.slice().sort((a, b) => compareSemver(a.version, b.version))[0];
  return `rough-ride is installed twice: ${listed}. Only one copy's hooks run, and each copy keeps its own data folder.` +
    ` Remove one: /plugin uninstall ${remove.id}`;
}

export function inlineMessage(pluginRoot, pluginsRoot, copies) {
  if (!copies || copies.length === 0) return null;
  const copy = cacheCopy(path.resolve(pluginRoot));
  if (copy && samePath(copy.pluginsRoot, pluginsRoot)) return null;
  return `rough-ride is loaded from ${printed(path.resolve(pluginRoot))} for this session (--plugin-dir) and replaces the installed copy.`;
}

// The non-blocking duplicate and inline lines, from the plugin data folder,
// which sits at <plugins root>/data/<name>/.
export function copyMessages(pluginRoot, pluginData, cwd) {
  if (!pluginData) return [];
  const pluginsRoot = path.dirname(path.dirname(path.resolve(pluginData)));
  let copies = null;
  try {
    copies = installedCopies(pluginsRoot, cwd);
  } catch (_) {
    copies = null;
  }
  return [duplicateMessage(copies), inlineMessage(pluginRoot, pluginsRoot, copies)].filter(Boolean);
}

export function validSession(id) {
  return typeof id === 'string' && SESSION_ID.test(id);
}

export function sessionMarker(pluginData, sessionId) {
  return path.join(pluginData, 'sessions', sessionId);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Deletes files in `dir` last modified more than 7 days before `now`.
export function pruneOld(dir, now) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && now - stat.mtimeMs > WEEK_MS) fs.unlinkSync(file);
    } catch (_) {
      // Gone already, or not ours to delete.
    }
  }
}
