import { escapeName } from './output.mjs';

// The command line every subcommand shares. Each subcommand's own flags are
// parsed by that subcommand; this layer knows the subcommand list and the
// global flags.

export const SUBCOMMANDS = [
  'quick',
  'standard',
  'plan',
  'snapshot',
  'link',
  'flow save',
  'attack',
  'regress',
  'repro',
  'pr-comment',
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface ParsedArgs {
  subcommand: Subcommand | null;
  // The word given where a subcommand belongs, for the header of a usage stop.
  word: string | null;
  json: boolean;
  help: boolean;
  version: boolean;
  pluginData: string | null;
  browser: 'chrome' | 'msedge' | 'chromium' | null;
  start: boolean;
  base: string | null;
  rest: string[];
  // flow save --run <id>.
  runId: string | null;
  // pr-comment --artifact-url <url>.
  artifactUrl: string | null;
  // attack --plan - and --check.
  planInput: boolean;
  check: boolean;
  // regress --only <name>, repeatable.
  only: string[];
  // repro --keep-open.
  keepOpen: boolean;
  error: string | null;
}

const LIST = SUBCOMMANDS.join(', ');

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    subcommand: null,
    word: null,
    json: false,
    help: false,
    version: false,
    pluginData: null,
    browser: null,
    start: false,
    base: null,
    rest: [],
    runId: null,
    artifactUrl: null,
    planInput: false,
    check: false,
    only: [],
    keepOpen: false,
    error: null,
  };
  const fail = (message: string) => {
    parsed.error ??= message;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--version') parsed.version = true;
    else if (arg === '--plugin-data' || arg.startsWith('--plugin-data=')) {
      const value = arg === '--plugin-data' ? argv[++i] : arg.slice('--plugin-data='.length);
      if (!value) fail('--plugin-data needs a folder.');
      else parsed.pluginData = value;
    } else if (arg === '--browser' || arg.startsWith('--browser=')) {
      const value = arg === '--browser' ? argv[++i] : arg.slice('--browser='.length);
      if (value === 'chrome' || value === 'msedge' || value === 'chromium') parsed.browser = value;
      else fail(`--browser takes chrome, msedge or chromium (got ${value === undefined ? 'nothing' : escapeName(value)}).`);
    } else if (arg === '--base' || arg.startsWith('--base=')) {
      const value = arg === '--base' ? argv[++i] : arg.slice('--base='.length);
      if (!value) fail('--base needs a ref, such as origin/main or a commit.');
      else parsed.base = value;
    } else if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg === '--only' ? argv[++i] : arg.slice('--only='.length);
      if (!value) fail('--only needs a test name.');
      else parsed.only.push(value);
    } else if (arg === '--run' || arg.startsWith('--run=')) {
      const value = arg === '--run' ? argv[++i] : arg.slice('--run='.length);
      if (!value) fail('--run needs a run id.');
      else parsed.runId = value;
    } else if (arg === '--artifact-url' || arg.startsWith('--artifact-url=')) {
      const value = arg === '--artifact-url' ? argv[++i] : arg.slice('--artifact-url='.length);
      parsed.artifactUrl = value ?? '';
    } else if (arg === '--plan' || arg.startsWith('--plan=')) {
      const value = arg === '--plan' ? argv[++i] : arg.slice('--plan='.length);
      if (value !== '-') fail('--plan takes - (the plan comes on stdin).');
      else parsed.planInput = true;
    } else if (arg === '--check') {
      parsed.check = true;
    } else if (arg === '--keep-open') {
      parsed.keepOpen = true;
    } else if (arg === '--start') {
      parsed.start = true;
    } else if (parsed.word === null) {
      if (arg.startsWith('-')) {
        fail(`Unknown flag ${escapeName(arg)}. Run rough-ride --help for the flags.`);
        continue;
      }
      if (arg === 'flow') {
        const next = argv[i + 1];
        parsed.word = next === undefined ? 'flow' : `flow ${next}`;
        if (next === 'save') {
          parsed.subcommand = 'flow save';
          i++;
        } else {
          fail(`Unknown subcommand "${parsed.word}". Subcommands: ${LIST}.`);
          i++;
        }
        continue;
      }
      parsed.word = arg;
      if ((SUBCOMMANDS as readonly string[]).includes(arg)) parsed.subcommand = arg as Subcommand;
      else fail(`Unknown subcommand "${arg}". Subcommands: ${LIST}.`);
    } else {
      parsed.rest.push(arg);
    }
  }
  // quick and standard take no other arguments; the other subcommands read their own.
  if (parsed.subcommand === 'quick' || parsed.subcommand === 'standard') {
    const extra = parsed.rest[0];
    if (extra !== undefined) {
      fail(extra.startsWith('-') ? `Unknown flag ${escapeName(extra)}. Run rough-ride --help for the flags.` : `${parsed.subcommand} takes no arguments (got ${escapeName(extra)}).`);
    }
  }
  // regress takes --only and no path; --only belongs to regress alone.
  if (parsed.subcommand === 'regress') {
    const extra = parsed.rest[0];
    if (extra !== undefined) fail(extra.startsWith('-') ? `Unknown flag ${escapeName(extra)}. Run rough-ride --help for the flags.` : `regress takes no path (got ${escapeName(extra)}). Use --only <name> to pick tests.`);
  } else if (parsed.subcommand === 'repro') {
    if (parsed.rest.length !== 1 || parsed.rest[0]!.startsWith('-')) fail(parsed.rest.length === 0 ? 'repro needs <run id>/r<n>, for example 20261025-141207-quick-k3fz/r01.' : `Unknown flag ${escapeName(parsed.rest.find((r) => r.startsWith('-')) ?? parsed.rest[1] ?? '')}. Run rough-ride --help for the flags.`);
  } else if (parsed.only.length > 0 && parsed.subcommand !== null) {
    fail('Unknown flag --only. Run rough-ride --help for the flags.');
  }
  if (parsed.subcommand === 'plan') {
    const flag = parsed.rest.find((r) => r.startsWith('-'));
    if (flag !== undefined) fail(`Unknown flag ${escapeName(flag)}. Run rough-ride --help for the flags.`);
    else if (parsed.rest.length !== 1 || (parsed.rest[0] !== 'quick' && parsed.rest[0] !== 'standard')) fail('plan takes quick or standard: rough-ride plan quick.');
  } else if (parsed.subcommand === 'snapshot' || parsed.subcommand === 'link') {
    const extra = parsed.rest[0];
    if (extra !== undefined) fail(extra.startsWith('-') ? `Unknown flag ${escapeName(extra)}. Run rough-ride --help for the flags.` : `${parsed.subcommand} takes no arguments (got ${escapeName(extra)}); its input comes on stdin.`);
    else if (parsed.runId === null && parsed.base === null) fail(`${parsed.subcommand} needs --run <id>, the run plan made.`);
  } else if (parsed.subcommand === 'attack') {
    const extra = parsed.rest[0];
    if (extra !== undefined) fail(extra.startsWith('-') ? `Unknown flag ${escapeName(extra)}. Run rough-ride --help for the flags.` : `attack takes no arguments (got ${escapeName(extra)}); name the run with --run <id>.`);
    // An unknown flag such as --base is reported first, below.
    else if (parsed.runId === null && parsed.base === null) fail('attack needs --run <id>, the run plan made.');
  } else if (parsed.planInput || parsed.check) {
    fail(`Unknown flag ${parsed.planInput ? '--plan' : '--check'}. Run rough-ride --help for the flags.`);
  }
  if (parsed.subcommand === 'pr-comment') {
    const flag = parsed.rest.find((r) => r.startsWith('-'));
    if (flag !== undefined) fail(`Unknown flag ${escapeName(flag)}. Run rough-ride --help for the flags.`);
    else if (parsed.rest.length !== 3) fail('pr-comment takes <quick|standard> <tier json> <regress json> [--artifact-url <url>].');
    else if (parsed.rest[0] !== 'quick' && parsed.rest[0] !== 'standard') fail(`pr-comment takes quick or standard as its tier (got ${escapeName(parsed.rest[0]!)}).`);
  } else if (parsed.artifactUrl !== null && parsed.subcommand !== null) {
    fail('Unknown flag --artifact-url. Run rough-ride --help for the flags.');
  }
  if (parsed.subcommand === 'flow save') {
    const flag = parsed.rest.find((r) => r.startsWith('-'));
    if (flag !== undefined) fail(`Unknown flag ${escapeName(flag)}. Run rough-ride --help for the flags.`);
    else if (parsed.rest.length === 0) fail('flow save needs one or more flow names, with one YAML document per name on stdin.');
    else if (parsed.runId === null && parsed.rest.some((n) => n.includes(':'))) fail('flow save takes <name>:<item> only with --run <id>.');
  } else if (parsed.runId !== null && parsed.subcommand !== null && !['snapshot', 'link', 'attack', 'flow save'].includes(parsed.subcommand)) {
    fail('Unknown flag --run. Run rough-ride --help for the flags.');
  }
  if (parsed.keepOpen && parsed.subcommand !== null && parsed.subcommand !== 'repro') fail('Unknown flag --keep-open. Run rough-ride --help for the flags.');
  // Only the subcommands that compute the diff take --base.
  if (parsed.base !== null && parsed.subcommand !== null && !['quick', 'standard', 'plan'].includes(parsed.subcommand)) {
    fail('Unknown flag --base. Run rough-ride --help for the flags.');
  }
  if (parsed.word === null && !parsed.help && !parsed.version) {
    fail(`No subcommand given. Subcommands: ${LIST}.`);
  }
  return parsed;
}

export const HELP = [
  'Usage: rough-ride <subcommand> [flags]',
  '',
  'Subcommands:',
  '  quick                          Attack the changes on this branch within the quick budget',
  '  standard                       Attack the changes on this branch within the standard budget',
  '  regress                        Run the committed regression tests',
  '  repro <id>                     Reproduce one finding in a visible browser',
  '  flow save                      Save a flow to .rough-ride/flows/',
  '  pr-comment                     Turn a CI run summary into a pull request comment',
  '  plan, snapshot, link, attack   Set by the plugin\'s skills',
  '',
  'Flags:',
  '  --browser chrome|msedge|chromium  Use this browser instead of the first one found',
  '  --start                        Start the app for this run and stop it afterwards',
  '  --base <ref>                   Compare with this commit instead of the default branch (quick, standard, plan)',
  '  --json                         Print one JSON document on stdout; text goes to stderr',
  '  --help                         Show this help',
  '  --version                      Show the rough-ride, Playwright and Node versions',
];
