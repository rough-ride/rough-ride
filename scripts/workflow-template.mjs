// The checks on the documented GitHub Actions workflow (spec part 13 section 51,
// Acceptance, and 53.5): `template-shas` compares the template's action pins with
// rough-patch's own workflows, and `template-checks` runs the static checks and
// compares both READMEs' fenced copy with the template byte for byte.
// Usage: node scripts/workflow-template.mjs template-shas | template-checks
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const TEMPLATE = 'packages/rough-patch/templates/github-actions/rough-patch.yml';
export const SECTION = '## Run rough-patch on pull requests (GitHub Actions)';
const USES = /^\s*(?:-\s+)?uses:\s*(.*)$/;
const PIN = /^\s*(?:-\s+)?uses:\s*([^@\s]+)@([0-9a-f]{40}) +# (v\S+)/;
const CI_ONLY = ['DEMO_EMAIL', 'DEMO_PASSWORD', 'SAMPLE_DB'];

// Every SHA-pinned `uses:` line: {action, sha, release, line}.
export function actionPins(text) {
  const pins = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = PIN.exec(l);
    if (m) pins.push({ action: m[1], sha: m[2], release: m[3], line: i + 1 });
  });
  return pins;
}

// `workflows` maps each own workflow's name to its text. A template `uses:` line
// that doesn't parse as a pin is reported, never skipped.
export function templateShasProblems(template, workflows) {
  const own = Object.entries(workflows).flatMap(([name, text]) => actionPins(text).map((p) => ({ ...p, name })));
  const problems = [];
  template.split(/\r?\n/).forEach((l, i) => {
    const m = USES.exec(l);
    if (m && !PIN.test(l)) problems.push(`${TEMPLATE}:${i + 1}: uses: ${m[1].trim()} is not pinned as owner/repo@<40 hex> # vN, so its SHA is unchecked`);
  });
  for (const pin of actionPins(template)) {
    const same = own.filter((o) => o.action === pin.action);
    if (same.length === 0) problems.push(`${TEMPLATE}:${pin.line}: ${pin.action} is not pinned in .github/workflows/, so its SHA is unchecked`);
    for (const o of same) {
      if (o.sha !== pin.sha || o.release !== pin.release) {
        problems.push(`${TEMPLATE}:${pin.line}: ${pin.action}@${pin.sha} # ${pin.release} differs from ${o.name}:${o.line}'s ${o.sha} # ${o.release}`);
      }
    }
  }
  return problems;
}

const steps = (job) => (Array.isArray(job?.steps) ? job.steps : []);
const isRunner = (s) => typeof s.run === 'string' && /\brough-patch\s+("\$RP_TIER"|regress)(?=\s|$)/.test(s.run);
const isRender = (s) => typeof s.run === 'string' && /\brough-patch\s+pr-comment\b/.test(s.run);
const sameKeys = (value, expected) => JSON.stringify(value) === JSON.stringify(expected);

// The static checks on the template's text.
export function templateProblems(text) {
  const problems = [];
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    return [`the template is not YAML: ${e.message}`];
  }

  if (!sameKeys(doc.permissions, {})) problems.push('the top-level permissions are not {}');
  const jobs = doc.jobs ?? {};
  for (const name of Object.keys(jobs)) if (name !== 'attack' && name !== 'comment') problems.push(`the template has a job ${name}; only attack and comment belong there`);
  if (!sameKeys(jobs.attack?.permissions, { contents: 'read' })) problems.push('the attack job holds other permissions than contents: read');
  if (!sameKeys(jobs.comment?.permissions, { 'pull-requests': 'write' })) problems.push('the comment job holds other permissions than pull-requests: write');

  for (const [name, job] of Object.entries(jobs)) {
    for (const s of steps(job)) if (typeof s.run === 'string' && s.run.includes('${{')) problems.push(`a run: block in ${name} (${s.name ?? 'unnamed step'}) contains \${{`);
  }

  const on = doc.on;
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  if (!sameKeys(triggers, ['pull_request'])) problems.push(`the triggers are ${triggers.join(', ') || 'none'}; the only trigger is pull_request`);
  const filters = on && typeof on === 'object' && !Array.isArray(on) ? Object.keys(on.pull_request ?? {}).filter((k) => /^(paths|paths-ignore|branches|branches-ignore)$/.test(k)) : [];
  if (filters.length > 0) problems.push(`pull_request has a filter: ${filters.join(', ')}`);

  const attack = steps(jobs.attack);
  const runners = attack.filter(isRunner);
  if (runners.length !== 2) problems.push(`the attack job has ${runners.length} runner steps; it needs the tier step and the regress step`);
  for (const name of CI_ONLY) {
    const count = text.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
    const inEnv = runners.filter((s) => s.env && name in s.env).length;
    if (inEnv !== 2 || count !== 2) problems.push(`${name} appears outside the two runner steps' env, or not in both`);
  }

  const render = attack.filter(isRender);
  if (render.length !== 1) problems.push(`the attack job has ${render.length} render steps; it needs one`);
  for (const s of [...runners, ...render]) if (s['continue-on-error'] !== true) problems.push(`${s.name ?? 'a runner step'} does not set continue-on-error: true`);
  const checkout = attack.filter((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
  const setup = attack.filter((s) => typeof s.uses === 'string' && /\/setup-[^@]*@/.test(s.uses));
  const install = attack.filter((s) => s.id === 'install');
  if (checkout.length === 0) problems.push('the attack job has no checkout step');
  if (setup.length === 0) problems.push('the attack job has no setup step');
  if (install.length === 0) problems.push('the attack job has no install step (id: install)');
  for (const s of [...checkout, ...setup, ...install]) if (s['continue-on-error'] !== undefined && s['continue-on-error'] !== false) problems.push(`${s.name ?? s.uses} sets continue-on-error; a failed checkout, setup or install must turn the job red`);
  return problems;
}

// The first fenced `yaml` block in the README's GitHub Actions section, or null.
export function readmeTemplateBlock(readme) {
  const lines = readme.split('\n');
  const heading = lines.indexOf(SECTION);
  if (heading === -1) return null;
  const open = lines.findIndex((l, i) => i > heading && l === '```yaml');
  if (open === -1 || lines.slice(heading + 1, open).some((l) => l.startsWith('## '))) return null;
  const close = lines.findIndex((l, i) => i > open && l === '```');
  if (close === -1) return null;
  return lines.slice(open + 1, close).join('\n') + '\n';
}

export function readmeProblems(name, readme, template) {
  const block = readmeTemplateBlock(readme);
  if (block === null) return [`${name} has no fenced yaml block under "${SECTION}"`];
  return Buffer.from(block, 'utf8').equals(template) ? [] : [`${name}'s fenced copy differs from ${TEMPLATE}`];
}

// The comment job's posting script (53.5), as the template holds it.
export function commentScript(text) {
  const step = steps(YAML.parse(text).jobs?.comment).find((s) => typeof s.run === 'string' && s.run.includes('gh api'));
  if (!step) throw new Error('the comment job has no step that runs gh api');
  return step.run;
}

// Runs the comment job's script under bash, as GitHub runs a `shell: bash` step,
// with a mocked `gh` on PATH. `body` is comment.md's text (null: no file),
// `comments` the PR's issue comments, `listFails` and `writeFails` make the
// lookup or the PATCH and POST fail. Returns the exit status, the output and
// every gh call with its arguments and stdin.
export function runCommentScript({ script, body = null, comments = [], listFails = false, writeFails = false, tier = 'quick' }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rp-comment-'));
  try {
    const bin = path.join(dir, 'bin');
    const temp = path.join(dir, 'runner-temp');
    mkdirSync(bin);
    mkdirSync(temp);
    if (body !== null) {
      mkdirSync(path.join(temp, 'rough-patch'));
      writeFileSync(path.join(temp, 'rough-patch', 'comment.md'), body);
    }
    writeFileSync(path.join(dir, 'comments.json'), JSON.stringify(comments));
    const gh = [
      `#!${process.execPath}`,
      "const { appendFileSync, readFileSync } = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      "const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);",
      "const stdin = at('--input') === '-' ? readFileSync(0, 'utf8') : null;",
      "appendFileSync(process.env.MOCK_GH_DIR + '/calls.jsonl', JSON.stringify({ args, stdin }) + '\\n');",
      "if (args.includes('--paginate')) {",
      "  if (process.env.MOCK_GH_LIST_FAILS) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }",
      "  const r = spawnSync('jq', ['-r', at('--jq')], { input: readFileSync(process.env.MOCK_GH_DIR + '/comments.json'), encoding: 'utf8' });",
      '  process.stdout.write(r.stdout);',
      '  process.exit(r.status);',
      '}',
      "if (process.env.MOCK_GH_WRITE_FAILS) { process.stderr.write('HTTP 403: Resource not accessible by integration\\n'); process.exit(1); }",
      "process.stdout.write('{}\\n');",
    ].join('\n');
    writeFileSync(path.join(bin, 'gh'), gh + '\n');
    chmodSync(path.join(bin, 'gh'), 0o755);
    writeFileSync(path.join(dir, 'step.sh'), script);
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: dir,
      RUNNER_TEMP: temp,
      RP_TIER: tier,
      GH_TOKEN: 'mock-token',
      REPO: 'acme/shop',
      PR: '7',
      HEAD_SHA: '9c1e0aa3d5f7b2c4e6a8091b2d3c4e5f60718293',
      RUN_URL: 'https://github.com/acme/shop/actions/runs/123',
      MOCK_GH_DIR: dir,
      ...(listFails ? { MOCK_GH_LIST_FAILS: '1' } : {}),
      ...(writeFails ? { MOCK_GH_WRITE_FAILS: '1' } : {}),
    };
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', path.join(dir, 'step.sh')], { env, encoding: 'utf8' });
    const log = path.join(dir, 'calls.jsonl');
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const written = path.join(temp, 'rough-patch', 'comment.md');
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, body: existsSync(written) ? readFileSync(written, 'utf8') : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ownWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  return Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [`.github/workflows/${f}`, readFileSync(path.join(dir, f), 'utf8')]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  const template = readFileSync(path.join(ROOT, TEMPLATE));
  const problems = [];
  if (command === 'template-shas') problems.push(...templateShasProblems(template.toString('utf8'), ownWorkflows(ROOT)));
  else if (command === 'template-checks') {
    problems.push(...templateProblems(template.toString('utf8')));
    for (const f of ['README.md', 'packages/rough-patch/README.md']) problems.push(...readmeProblems(f, readFileSync(path.join(ROOT, f), 'utf8'), template));
  } else {
    console.log('Usage: node scripts/workflow-template.mjs template-shas | template-checks');
    process.exit(64);
  }
  for (const p of problems) console.log(p);
  if (problems.length > 0) process.exit(1);
  console.log(`${command}: ok`);
}
