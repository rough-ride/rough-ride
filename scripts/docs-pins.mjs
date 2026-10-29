// The `docs-pins` CI job (spec part 13 section 51, Acceptance; ticket 21 item 4):
// every `uses:` line in the READMEs, docs/ and the package's templates/ pins an
// action as owner/repo@<40 hex> followed by a `# vN` release comment.
// Usage: node scripts/docs-pins.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const USES = /^\s*(?:-\s+)?uses:\s*(.*)$/;
const PINNED = /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40} +# v\d+(?:\.\d+)*(?:\s.*)?$/;

// The files docs-pins reads, repository-relative with forward slashes.
export function docsFiles(root = ROOT) {
  const out = ['README.md', 'packages/rough-ride/README.md'].filter((f) => existsSync(path.join(root, f)));
  for (const dir of ['docs', 'packages/rough-ride/templates']) {
    if (!existsSync(path.join(root, dir))) continue;
    for (const f of readdirSync(path.join(root, dir), { recursive: true })) {
      if (/\.(md|ya?ml)$/.test(String(f))) out.push(`${dir}/${String(f).split(path.sep).join('/')}`);
    }
  }
  return out;
}

// One problem per `uses:` line that is not pinned by SHA with a release comment.
export function pinProblems(name, text) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = USES.exec(line);
    if (m && !PINNED.test(m[1].trim())) problems.push(`${name}:${i + 1}: uses: ${m[1].trim()} is not pinned as owner/repo@<40 hex> # vN`);
  });
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = docsFiles().flatMap((f) => pinProblems(f, readFileSync(path.join(ROOT, f), 'utf8')));
  for (const p of problems) console.log(p);
  if (problems.length > 0) process.exit(1);
  console.log('docs-pins: ok');
}
