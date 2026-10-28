// Appends one JSON line per hook call: the event name, the hook's stdin and
// the environment variables the probes ask about. Always exits 0.
import { appendFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let parsed = null;
  try { parsed = JSON.parse(input || 'null'); } catch { parsed = input; }
  const env = Object.fromEntries(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'AI_AGENT'].map((k) => [k, process.env[k] ?? null]));
  appendFileSync(process.env.RP_PROBE_LOG ?? '/tmp/rp-probe.jsonl', JSON.stringify({ event: process.argv[2], argv: process.argv.slice(3), input: parsed, env }) + '\n');
  process.exit(0);
});
