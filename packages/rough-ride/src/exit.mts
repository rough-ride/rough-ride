// One status and exit-code table for every subcommand (part 9 section 39).

export type Status =
  | 'passed'
  | 'findings'
  | 'incomplete'
  | 'nothing-to-attack'
  | 'nothing-attacked'
  | 'planned'
  | 'stopped'
  | 'interrupted'
  | 'internal-error';

export type StopKind = 'usage' | 'environment' | 'retry' | 'setup';

export const STOP_EXIT: Record<StopKind, number> = {
  usage: 64,
  environment: 69,
  retry: 75,
  setup: 78,
};

export const STOP_CODES = {
  usage: ['usage', 'unknown-test', 'unknown-ref', 'no-repository', 'home-root'],
  environment: [
    'node-too-old',
    'packages-missing',
    'claude-code-too-old',
    'plugin-data-mismatch',
    'no-browser',
    'browser-launch-failed',
    'git-missing',
    'git-not-windows',
    'git-failed',
    'write-failed',
  ],
  retry: [
    'busy',
    'repro-open',
    'run-not-found',
    'run-attacked',
    'run-other-version',
    'code-changed',
    'refused-run-output',
  ],
  setup: [
    'schema-newer',
    'schema-older',
    'files-invalid',
    'env-missing',
    'ask',
    'nothing-running',
    'nothing-at-api',
    'target-unproven',
    'target-not-loopback',
    'start-conflict',
    'start-failed',
    'start-timeout',
    'reset-failed',
    'folder-shape',
    'sparse-checkout',
    'no-base',
    'no-merge-base',
    'unmerged-paths',
    'plan-refused',
  ],
} as const satisfies Record<StopKind, readonly string[]>;

export type StopCode = (typeof STOP_CODES)[StopKind][number];

export interface Stop {
  kind: StopKind;
  code: StopCode;
  lines: string[];
}

export type Verdict = 0 | 1 | 2;

export const VERDICT_STATUS: Record<Verdict, readonly Status[]> = {
  0: ['passed', 'nothing-to-attack', 'nothing-attacked', 'planned'],
  1: ['findings'],
  2: ['incomplete'],
};

export interface Outcome {
  internalError?: boolean;
  signal?: 'SIGINT' | 'SIGTERM';
  stop?: Stop;
  verdicts?: Verdict[];
}

export interface Result {
  exitCode: number;
  status: Status | null;
  stopKind: StopKind | null;
}

// 70, 130 and 143 override everything; a stop ends the invocation; among
// verdicts 1 beats 2, which beats 0. `status` is null for verdict 0 because the
// subcommand picks which of the four passing statuses applies.
export function resolveExit(outcome: Outcome): Result {
  if (outcome.internalError) return { exitCode: 70, status: 'internal-error', stopKind: null };
  if (outcome.signal) {
    return { exitCode: outcome.signal === 'SIGINT' ? 130 : 143, status: 'interrupted', stopKind: null };
  }
  if (outcome.stop) {
    return { exitCode: STOP_EXIT[outcome.stop.kind], status: 'stopped', stopKind: outcome.stop.kind };
  }
  const verdicts = outcome.verdicts ?? [];
  if (verdicts.includes(1)) return { exitCode: 1, status: 'findings', stopKind: null };
  if (verdicts.includes(2)) return { exitCode: 2, status: 'incomplete', stopKind: null };
  return { exitCode: 0, status: null, stopKind: null };
}

export function stopKindOf(code: StopCode): StopKind {
  for (const kind of Object.keys(STOP_CODES) as StopKind[]) {
    if ((STOP_CODES[kind] as readonly string[]).includes(code)) return kind;
  }
  throw new Error(`unknown stop code ${code}`);
}

export function makeStop(code: StopCode, lines: string[]): Stop {
  return { kind: stopKindOf(code), code, lines };
}

// Thrown from deep inside an invocation; main prints the stop and exits with
// its code.
export class StopError extends Error {
  readonly stop: Stop;
  // Set when the stop wrote run output, such as an upgrade patch.
  readonly run: { id: string; dir: string } | null;
  // Output of reset or --start, printed in place of the line TAIL_PLACEHOLDER
  // starts, and never written to a file.
  readonly tail: string[] | null;

  constructor(stop: Stop, run: { id: string; dir: string } | null = null, tail: string[] | null = null) {
    super(stop.lines.join('\n'));
    this.stop = stop;
    this.run = run;
    this.tail = tail;
  }
}

export function stopWith(code: StopCode, ...lines: string[]): never {
  throw new StopError(makeStop(code, lines));
}

export const TAIL_PLACEHOLDER = '(last 20 lines of ';
