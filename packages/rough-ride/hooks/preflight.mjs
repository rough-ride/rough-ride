// The skills' preflight line (spec part 1 section 4, part 11 section 41.1).
// Exits 1, which aborts the skill, when Claude Code is below the floor, the
// Bash tool's Node is below 22.22, or the plugin's packages are missing.
// Otherwise it prints the duplicate, inline and edit-guard lines and exits 0.
// It deletes this session's adversary-runs/ file first, so an earlier run
// never counts. Node 18 syntax: the old-Node message has to print.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyMessages,
  EDIT_GUARD_OFF,
  floorMessage,
  runnerNodeMessage,
  packagesMessage,
  sessionMarker,
  validSession,
} from './plugin-checks.mjs';

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginData = process.argv[2] || null;
const session = process.env.CLAUDE_CODE_SESSION_ID;

if (pluginData && validSession(session)) {
  try {
    fs.unlinkSync(path.join(pluginData, 'adversary-runs', `${session}.json`));
  } catch (_) {
    // No earlier run in this session.
  }
}

const blocking = [
  floorMessage(pluginRoot, process.env),
  runnerNodeMessage(process.versions, process.execPath),
  packagesMessage(pluginRoot),
].filter(Boolean);

if (blocking.length > 0) {
  process.stdout.write(blocking.join('\n') + '\n');
  process.exitCode = 1;
} else {
  const lines = copyMessages(pluginRoot, pluginData, process.cwd());
  if (pluginData && !(validSession(session) && fs.existsSync(sessionMarker(pluginData, session)))) lines.push(EDIT_GUARD_OFF);
  if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n');
}
