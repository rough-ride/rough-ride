// SubagentStop probe: blocks the first stop with a reason (exit 2), lets later ones pass.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const log = process.env.RP_PROBE_LOG ?? '/tmp/rp-probe.jsonl';
  const marker = log + '.stopped';
  const first = !existsSync(marker);
  appendFileSync(log, JSON.stringify({ event: first ? 'stop-blocked' : 'stop-passed', input: JSON.parse(input || 'null') }) + '\n');
  if (first) {
    writeFileSync(marker, '');
    process.stderr.write('Before stopping, run this Bash command: echo after-block\n');
    process.exit(2);
  }
  process.exit(0);
});
