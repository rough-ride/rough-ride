// Starting the target for one invocation with --start (spec part 2 section
// 8.4), and ending every process it launched, children included.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { makeStop, StopError } from './exit.mjs';
import { redactSecrets } from './secrets.mjs';

export interface Started {
  pids: number[];
  stop(): void;
}

export interface StartOptions {
  commands: string[];
  cwd: string;
  timeoutMs: number;
  ready: () => Promise<boolean>;
  // What is being waited for, for the timeout line.
  describe: string;
  secrets: string[];
}

const TAIL = 20;

// Extra values a caller names, then every registered secret.
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('<redacted>');
  }
  return redactSecrets(out);
}

function tailRecorder() {
  const lines: string[] = [];
  let partial = '';
  return {
    record(chunk: Buffer) {
      const parts = (partial + chunk.toString('utf8')).split(/\r?\n/);
      partial = parts.pop() ?? '';
      lines.push(...parts);
      if (lines.length > TAIL) lines.splice(0, lines.length - TAIL);
    },
    lines(): string[] {
      return (partial ? [...lines, partial] : lines).slice(-TAIL);
    },
  };
}

// Runs one command to its end through the shell, keeping only the last 20
// lines of its output, in memory.
export function runToEnd(command: string, cwd: string): Promise<{ code: number | null; signal: string | null; tail: string[] }> {
  return new Promise((resolve) => {
    const tail = tailRecorder();
    const child = spawn(command, { cwd, shell: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout?.on('data', tail.record);
    child.stderr?.on('data', tail.record);
    child.on('error', (error) => resolve({ code: null, signal: (error as NodeJS.ErrnoException).code ?? 'error', tail: tail.lines() }));
    child.on('close', (code, signal) => resolve({ code, signal, tail: tail.lines() }));
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    // The child leads its own process group, so this reaches its children too.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// Every command runs side by side through the shell, in its own process group,
// with the runner's environment unchanged. Resolves once `ready` holds.
export async function startCommands(options: StartOptions): Promise<Started> {
  const children: ChildProcess[] = [];
  const lines: string[] = [];
  let partial = '';
  const record = (chunk: Buffer) => {
    const text = partial + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    partial = parts.pop() ?? '';
    lines.push(...parts);
    if (lines.length > TAIL) lines.splice(0, lines.length - TAIL);
  };
  const stopAll = () => children.forEach(killTree);
  process.on('exit', stopAll);

  let failed: string | null = null;
  for (const command of options.commands) {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);
    child.on('error', (error) => {
      failed ??= `${command} could not start (${(error as NodeJS.ErrnoException).code ?? error.message})`;
    });
    child.on('exit', (code, signal) => {
      failed ??= `${command} exited with ${signal ?? `code ${code}`} before the app answered`;
    });
    children.push(child);
  }

  const tail = () => {
    const all = partial ? [...lines, partial].slice(-TAIL) : lines;
    return all.map((line) => redact(line, options.secrets));
  };
  const fail = (code: 'start-failed' | 'start-timeout', message: string): never => {
    stopAll();
    process.off('exit', stopAll);
    throw new StopError(
      makeStop(code, [message, "(last 20 lines of --start's output: printed only)"]),
      null,
      ["Last 20 lines of --start's output:", ...tail().map((l) => `  ${l}`)],
    );
  };

  const until = Date.now() + options.timeoutMs;
  for (;;) {
    if (failed !== null) fail('start-failed', `--start failed: ${failed}.`);
    if (await options.ready()) break;
    if (Date.now() >= until) {
      fail('start-timeout', `--start timed out: ${options.describe} did not answer within ${Math.round(options.timeoutMs / 1000)} s.`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    pids: children.map((c) => c.pid!).filter(Boolean),
    stop() {
      stopAll();
      process.off('exit', stopAll);
    },
  };
}
