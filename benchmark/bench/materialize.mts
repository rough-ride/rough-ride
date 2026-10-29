// `npm run bench -- materialize <app> <feature> [<bug>]` (spec part 7 section 29.5).
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filesUnder, loadApp, productSlug } from './apps.mts';

export const FIXED_DATE = '2026-01-01T00:00:00Z';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const WINDOWS_ROOT_LIMIT = 40;

export interface MaterializeOptions {
  workDir?: string;
  install?: boolean;
  platform?: NodeJS.Platform;
}

function randomName(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

// git with an empty global config, no system config, no signing and no line-ending conversion.
function gitIn(cwd: string, emptyConfig: string, args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Dev',
        GIT_AUTHOR_EMAIL: 'dev@example.com',
        GIT_AUTHOR_DATE: FIXED_DATE,
        GIT_COMMITTER_NAME: 'Dev',
        GIT_COMMITTER_EMAIL: 'dev@example.com',
        GIT_COMMITTER_DATE: FIXED_DATE,
      },
    },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
}

function install(dir: string): void {
  const shell = process.platform === 'win32';
  for (const file of filesUnder(dir)) {
    const folder = path.join(dir, path.dirname(file));
    let command: [string, string[]] | null = null;
    if (path.basename(file) === 'package-lock.json') command = ['npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']];
    if (path.basename(file) === 'uv.lock') command = ['uv', ['sync', '--frozen', '--quiet']];
    if (command === null) continue;
    const result = spawnSync(command[0], command[1], { cwd: folder, stdio: 'inherit', shell });
    if (result.status !== 0) throw new Error(`${command[0]} ${command[1].join(' ')} failed in ${folder}`);
  }
}

// The base alone, committed exactly as materialize's step 2 does, with no
// feature: the three-OS CI app (tickets 11 and 15).
export function materializeBase(appId: string, options: MaterializeOptions = {}): string {
  const app = loadApp(appId);
  const { dir } = baseRepoWithConfig(app, options);
  if (options.install !== false) install(dir);
  return dir;
}

function baseRepoWithConfig(app: ReturnType<typeof loadApp>, options: MaterializeOptions): { dir: string; emptyConfig: string } {
  const root = realpathSync.native(options.workDir ?? tmpdir());
  if ((options.platform ?? process.platform) === 'win32' && root.length > WINDOWS_ROOT_LIMIT) {
    throw new Error(`the work root ${root} is longer than ${WINDOWS_ROOT_LIMIT} characters; pass a shorter --work-dir`);
  }
  const outer = path.join(root, randomName());
  mkdirSync(outer);
  const dir = path.join(outer, productSlug(app.yaml.product));
  cpSync(path.join(app.dir, 'base'), dir, { recursive: true });
  const configDir = mkdtempSync(path.join(tmpdir(), 'bench-git-'));
  const emptyConfig = path.join(configDir, 'gitconfig');
  writeFileSync(emptyConfig, '');
  gitIn(dir, emptyConfig, ['init', '-q']);
  gitIn(dir, emptyConfig, ['add', '-A']);
  gitIn(dir, emptyConfig, ['commit', '-q', '-m', 'Initial commit']);
  return { dir, emptyConfig };
}

export function materialize(appId: string, featureId: string, bugId: string | null, options: MaterializeOptions = {}): string {
  const app = loadApp(appId);
  const feature = app.features.find((f) => f.id === featureId);
  if (!feature) throw new Error(`no feature ${featureId} in ${appId}`);
  const bug = bugId === null ? null : feature.bugs.find((b) => b.id === bugId);
  if (bugId !== null && !bug) throw new Error(`no bug ${bugId} in ${appId}/${featureId}`);

  const { dir, emptyConfig } = baseRepoWithConfig(app, options);
  gitIn(dir, emptyConfig, ['apply', path.join(feature.dir, 'feature.patch')]);
  if (bug) gitIn(dir, emptyConfig, ['apply', path.join(bug.dir, 'bug.patch')]);

  const specs = path.join(dir, '.rough-ride', 'specs');
  mkdirSync(specs, { recursive: true });
  copyFileSync(path.join(feature.dir, 'request.md'), path.join(specs, 'request.txt'));
  if (options.install !== false) install(dir);
  return dir;
}

export function existsVariant(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}
