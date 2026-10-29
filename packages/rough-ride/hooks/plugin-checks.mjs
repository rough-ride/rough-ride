// The plugin-copy checks the session-start hook and the preflight share (spec
// part 1 sections 4 and 5). Hand-written, not tsc output: Node 18 syntax and
// APIs only, no dependencies, because hooks run on whatever Node Claude Code
// finds. Every check returns null when its inputs are unreadable.

import fs from 'node:fs';
import path from 'node:path';

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

function slashes(p) {
  return p.split(path.sep).join('/');
}

function samePath(a, b) {
  const norm = (p) => {
    let s = path.resolve(p);
    try {
      s = fs.realpathSync.native(s);
    } catch (_) {
      // Compared as written.
    }
    s = s.split(/[\\/]+/).join('/').replace(/\/$/, '');
    return process.platform === 'darwin' || process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function ownVersion(pluginRoot) {
  const pkg = readJson(path.join(pluginRoot, 'package.json'));
  return pkg && typeof pkg.version === 'string' ? pkg.version : null;
}

// This copy's id, from <plugins root>/cache/<marketplace>/<plugin>/<version>/.
export function copyId(pluginRoot) {
  const parts = path.resolve(pluginRoot).split(/[\\/]/);
  const cache = parts.lastIndexOf('cache');
  if (cache > 0 && parts[cache - 1] === 'plugins' && parts[cache + 1] && parts[cache + 2]) {
    return `${parts[cache + 2]}@${parts[cache + 1]}`;
  }
  return 'rough-ride';
}

export function claudeCodeVersion(env) {
  const agent = /^claude-code_(\d+)-(\d+)-(\d+)/.exec(env.AI_AGENT || '');
  if (agent) return `${agent[1]}.${agent[2]}.${agent[3]}`;
  const last = path.basename(env.CLAUDE_CODE_EXECPATH || '');
  return /^\d+\.\d+\.\d+$/.test(last) ? last : null;
}

export function floorMessage(pluginRoot, env) {
  const version = claudeCodeVersion(env);
  if (version === null || compareSemver(version, CLAUDE_FLOOR) >= 0) return null;
  const own = ownVersion(pluginRoot) || '';
  return `rough-ride ${own} needs Claude Code ${CLAUDE_FLOOR} or later; this session runs ${version}.` +
    ' Older versions let a failed edit-blocking hook through. Update with claude update, restart Claude Code, then run /rough-ride:quick again.';
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
  if (inside(pluginRoot, path.join(pluginsRoot, 'cache'))) return null;
  return `rough-ride is loaded from ${slashes(path.resolve(pluginRoot))} for this session (--plugin-dir) and replaces the installed copy.`;
}

// The non-blocking duplicate and inline lines, from the plugin data folder.
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
