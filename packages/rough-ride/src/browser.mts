// Which browser runs the flows, and launching it (spec part 3 sections 11.2
// and 11.3). Chromium family only; never Playwright's headless shell.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import { stopWith } from './exit.mjs';
import type { Note } from './output.mjs';

export type BrowserName = 'chrome' | 'msedge' | 'chromium';
export const BROWSER_NAMES: readonly BrowserName[] = ['chrome', 'msedge', 'chromium'];

const TITLES: Record<BrowserName, string> = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  chromium: 'Playwright Chromium',
};

// Header line 3's spelling: `Chrome 155.0.8059.81`.
export const SHORT_TITLES: Record<BrowserName, string> = { chrome: 'Chrome', msedge: 'Edge', chromium: 'Chromium' };

export const LAUNCH_TIMEOUT_MS = 30_000;

const require = createRequire(import.meta.url);

export function playwrightCoreDir(): string {
  return path.dirname(require.resolve('playwright-core/package.json'));
}

// The Chromium build the pinned playwright-core bundles: 156.0.8078.4, revision 1248.
export function bundledChromium(): { revision: string; version: string; major: number } {
  const file = path.join(playwrightCoreDir(), 'browsers.json');
  const entry = (JSON.parse(readFileSync(file, 'utf8')) as { browsers: { name: string; revision: string; browserVersion: string }[] })
    .browsers.find((b) => b.name === 'chromium')!;
  return { revision: entry.revision, version: entry.browserVersion, major: Number(entry.browserVersion.split('.')[0]) };
}

export function playwrightCacheDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  return path.join(env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'ms-playwright');
}

function channelPaths(name: 'chrome' | 'msedge', env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return name === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter((r): r is string => !!r);
    const tail = name === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    return roots.map((r) => path.join(r, ...tail));
  }
  return name === 'chrome' ? ['/opt/google/chrome/chrome'] : ['/opt/microsoft/msedge/msedge'];
}

export interface Installed {
  (name: BrowserName): boolean;
}

// Whether each browser is on this machine, without launching anything.
export function installedOnThisMachine(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Installed {
  return (name) => {
    if (name === 'chromium') {
      const dir = path.join(playwrightCacheDir(env, platform), `chromium-${bundledChromium().revision}`);
      return existsSync(path.join(dir, 'INSTALLATION_COMPLETE'));
    }
    return channelPaths(name, env, platform).some((p) => existsSync(p));
  };
}

export interface BrowserChoice {
  name: BrowserName;
  // Where the pin came from, or null when the order picked it.
  pinnedBy: '--browser' | 'config' | null;
}

function downloadLines(env: NodeJS.ProcessEnv): string[] {
  return [
    `To download Chromium for rough-ride (about 195 to 207 MB) into ${playwrightCacheDir(env)}, run:`,
    `  node "${path.join(playwrightCoreDir(), 'cli.js')}" install --no-shell --no-remove chromium`,
    'Behind a proxy, set HTTPS_PROXY (npm\'s proxy setting does not reach this download) and allow cdn.playwright.dev and storage.googleapis.com. Set PLAYWRIGHT_DOWNLOAD_HOST for a mirror and NODE_EXTRA_CA_CERTS for a TLS-inspecting proxy.',
  ];
}

// The flag beats the config, which beats the order Chrome, Edge, Chromium. A
// pinned browser that isn't installed is never replaced.
export function chooseBrowser(
  flag: BrowserName | null,
  config: BrowserName | null,
  installed: Installed,
  env: NodeJS.ProcessEnv = process.env,
): BrowserChoice {
  const pinned = flag ?? config;
  const { version } = bundledChromium();
  if (pinned !== null) {
    if (installed(pinned)) return { name: pinned, pinnedBy: flag ? '--browser' : 'config' };
    const where = flag ? `--browser ${pinned}` : `browser: ${pinned} in .rough-ride/config.yaml`;
    const what = pinned === 'chromium' ? `Playwright Chromium ${version}` : TITLES[pinned];
    const change = flag ? '--browser' : 'browser:';
    return stopWith(
      'no-browser',
      `No browser found: ${where} names ${what}, which isn't installed. rough-ride doesn't switch browsers on its own: install it, or change ${change}.`,
      ...(pinned === 'chromium' ? downloadLines(env) : []),
    );
  }
  for (const name of BROWSER_NAMES) if (installed(name)) return { name, pinnedBy: null };
  return stopWith(
    'no-browser',
    `No browser found: no Google Chrome, no Microsoft Edge, no Playwright Chromium ${version}.`,
    ...downloadLines(env),
  );
}

export interface Launched {
  browser: Browser;
  name: BrowserName;
  version: string;
  // The loopback port the localhost guard connects to, when the launch opened one.
  debugPort: number | null;
}

export type Launcher = (name: BrowserName) => Promise<{ browser: Browser; debugPort: number | null }>;

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

// `extraArgs` is for tests only (such as --host-resolver-rules).
export function makeLauncher(extraArgs: string[] = []): Launcher {
  return async (name) => {
    const { chromium } = await import('playwright-core');
    const debugPort = await freeLoopbackPort();
    // channel 'chromium' is the full Chromium build in new headless mode; the
    // default would launch the headless shell, which reads no browser policy.
    // The debugging port, on 127.0.0.1 only, carries the localhost guard's own
    // CDP connection next to Playwright's pipe.
    const browser = await chromium.launch({
      channel: name,
      headless: true,
      timeout: LAUNCH_TIMEOUT_MS,
      args: [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', ...extraArgs],
      // The runner owns SIGINT and SIGTERM: it writes the summary first, and the
      // browser ends with the process (51.13).
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    return { browser, debugPort };
  };
}

export const playwrightLauncher: Launcher = makeLauncher();

// A launch that fails or takes longer than 30 s is a policy stop: the runner
// never tries a second browser.
export async function launchBrowser(
  choice: BrowserChoice,
  notes: Note[],
  launcher: Launcher = playwrightLauncher,
  timeoutMs = LAUNCH_TIMEOUT_MS,
): Promise<Launched> {
  const policy = `Couldn't start ${TITLES[choice.name]} with remote debugging. Your organisation's browser policy may turn it off (RemoteDebuggingAllowed). rough-ride doesn't switch browsers on its own; set browser: in .rough-ride/config.yaml only if your organisation allows it.`;
  let timer: NodeJS.Timeout | undefined;
  const pending = launcher(choice.name);
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  let launched: { browser: Browser; debugPort: number | null } | 'timeout';
  try {
    launched = await Promise.race([pending, timeout]);
  } catch (error) {
    const missing = linuxMissingLibraries(error);
    if (missing) stopWith('browser-launch-failed', ...missing);
    return stopWith('browser-launch-failed', policy);
  } finally {
    clearTimeout(timer);
  }
  if (launched === 'timeout') {
    pending.then((l) => l.browser.close()).catch(() => {});
    return stopWith('browser-launch-failed', policy);
  }
  const { browser, debugPort } = launched;
  const version = browser.version();
  const { major } = bundledChromium();
  if (Number(version.split('.')[0]) > major) {
    const { version: playwright } = JSON.parse(readFileSync(path.join(playwrightCoreDir(), 'package.json'), 'utf8')) as { version: string };
    notes.push({
      id: 'browser-newer',
      text: `Browser newer than Playwright: ${SHORT_TITLES[choice.name]} ${version} is newer than Chromium ${major}, which Playwright ${playwright} was released with. rough-ride still uses it; results may differ until rough-ride updates Playwright.`,
    });
  }
  return { browser, name: choice.name, version, debugPort };
}

// Only after a Linux launch fails on a missing system library.
function linuxMissingLibraries(error: unknown): string[] | null {
  if (process.platform !== 'linux') return null;
  const text = String((error as Error)?.message ?? error);
  if (!/error while loading shared libraries|Host system is missing dependencies/i.test(text)) return null;
  const cli = path.join(playwrightCoreDir(), 'cli.js');
  const debian = existsSync('/etc/debian_version');
  return debian
    ? ['The browser could not start: this Linux is missing system libraries it needs. Install them with:', `  sudo node "${cli}" install-deps chromium`]
    : ['The browser could not start: this Linux is missing system libraries it needs. Install them with your distribution\'s packages:', ...text.split('\n').filter((l) => /lib\S+\.so/.test(l)).slice(0, 10).map((l) => `  ${l.trim()}`)];
}
