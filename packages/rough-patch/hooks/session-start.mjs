// The SessionStart hook (spec part 1 section 4): warns about duplicate or
// inline copies, an old Claude Code, missing packages and an old Node for
// hooks, as systemMessage only. It writes this session's empty marker, which
// tells the preflight and the runner the hooks started, and deletes markers
// older than 7 days. Node 18 syntax; it always exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyMessages,
  floorMessage,
  nodeMessage,
  packagesMessage,
  pruneOld,
  sessionMarker,
  validSession,
} from './plugin-checks.mjs';

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (_) {
    return {};
  }
}

function attempt(fn) {
  try {
    return fn();
  } catch (_) {
    return null;
  }
}

function run() {
  const input = readStdin();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const pluginData = process.env.CLAUDE_PLUGIN_DATA || null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();

  if (pluginData && validSession(input.session_id)) {
    attempt(() => {
      const marker = sessionMarker(pluginData, input.session_id);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      pruneOld(path.dirname(marker), Date.now());
      fs.writeFileSync(marker, '');
    });
  }

  const messages = [
    ...(attempt(() => copyMessages(pluginRoot, pluginData, cwd)) || []),
    attempt(() => floorMessage(pluginRoot, process.env)),
    attempt(() => packagesMessage(pluginRoot)),
    attempt(() => nodeMessage(process.versions, process.execPath)),
  ].filter(Boolean);
  if (messages.length > 0) process.stdout.write(JSON.stringify({ systemMessage: messages.join('\n') }) + '\n');
}

try {
  run();
} catch (_) {
  // A hook never fails the session.
}
process.exitCode = 0;
