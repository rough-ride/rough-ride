// test-tarball step 4: start the plugin's MCP entry exactly as plugin.json
// declares it and check that it answers MCP `initialize` over stdio.
// Usage: node scripts/mcp-initialize.mjs <unpacked plugin dir>
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'packages/rough-patch');
const plugin = JSON.parse(readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
const entry = plugin.mcpServers['rough-patch-devtools'];
const data = mkdtempSync(path.join(tmpdir(), 'rp-plugin-data-'));
const sub = (s) => s.replaceAll('${CLAUDE_PLUGIN_DATA}', data).replaceAll('${CLAUDE_PLUGIN_ROOT}', dir);
const child = spawn(entry.command, entry.args.map(sub), {
  env: { ...process.env, ...entry.env },
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
});
const timer = setTimeout(() => {
  console.error('mcp-initialize: no answer to initialize within 120 s');
  child.kill();
  process.exit(1);
}, 120_000);
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (const line of buffer.split('\n').slice(0, -1)) {
    const message = JSON.parse(line);
    if (message.id === 1 && message.result?.serverInfo) {
      console.log(`mcp-initialize: ${message.result.serverInfo.name} ${message.result.serverInfo.version} answered (protocol ${message.result.protocolVersion})`);
      clearTimeout(timer);
      child.kill();
      process.exit(0);
    }
  }
  buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
});
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rough-patch-test-tarball', version: '0' } },
}) + '\n');
