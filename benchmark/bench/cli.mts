// npm run bench -- <command>. Never published, never imports the runner.
import { lint } from './lint.mts';
import { materialize, materializeBase } from './materialize.mts';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'materialize') {
    const args = [...rest];
    const workDir = flag(args, '--work-dir');
    const noInstall = args.includes('--no-install');
    const positional = args.filter((a) => a !== '--no-install');
    const [app, feature, bug] = positional;
    if (!app || !feature) {
      console.error('Usage: npm run bench -- materialize <app> <feature> [<bug>] [--work-dir <dir>] [--no-install]');
      return 64;
    }
    console.log(materialize(app, feature, bug ?? null, { ...(workDir ? { workDir } : {}), install: !noInstall }));
    return 0;
  }
  if (command === 'materialize-base') {
    const args = [...rest];
    const workDir = flag(args, '--work-dir');
    const noInstall = args.includes('--no-install');
    const [app] = args.filter((a) => a !== '--no-install');
    if (!app) {
      console.error('Usage: npm run bench -- materialize-base <app> [--work-dir <dir>] [--no-install]');
      return 64;
    }
    console.log(materializeBase(app, { ...(workDir ? { workDir } : {}), install: !noInstall }));
    return 0;
  }
  if (command === 'lint') {
    const problems = lint(rest);
    for (const p of problems) console.log(p);
    if (problems.length === 0) console.log('bench lint: ok');
    return problems.length === 0 ? 0 : 1;
  }
  console.error('Commands: materialize, materialize-base, lint');
  return 64;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`bench: ${(error as Error).message}`);
  process.exitCode = 1;
}
