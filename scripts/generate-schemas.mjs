// Writes packages/rough-ride/src/schemas/*.schema.json. The locator and check
// condition subschemas appear inline in several files and must stay identical,
// and JSON Schema's $ref is outside the allowed keywords, so one script builds
// them all. Run it after changing a format: node scripts/generate-schemas.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const SCHEMAS = new URL('../packages/rough-ride/src/schemas/', import.meta.url);
const FORMATS = readFileSync(new URL('../packages/rough-ride/src/formats.mts', import.meta.url), 'utf8');

function current(kind) {
  const match = new RegExp(`${kind}: \\{ current: '([0-9.]+)'`).exec(FORMATS);
  if (!match) throw new Error(`no current for ${kind} in formats.mts`);
  return match[1];
}

const VERSION = '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$';
const NAME = '^[a-z0-9][a-z0-9-]{0,47}$';
const LINE_160 = '^[ -~]{1,160}$';
const FAULTS = ['500', '400', '401', '429', 'malformed-json', 'empty-200', 'reset', 'hang', 'delay-3s'];
const GENERIC_CHECKS = [
  'one-write', 'no-5xx-on-bad-input', 'visible-error-message', 'settles', 'latest-response-wins',
  'values-survive', 'retry-recovers', 'no-broken-text', 'no-uncaught-error', 'no-overflow-375',
];
const STEP_KINDS = ['goto', 'click', 'fill', 'select', 'check', 'press', 'expect'];

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  required,
  additionalProperties: false,
  properties,
});
const string = (pattern) => (pattern ? { type: 'string', pattern } : { type: 'string' });
const list = (items) => ({ type: 'array', items });
const count = { type: 'integer', minimum: 0 };

const LOCATOR = {
  description: 'Exactly one of role (with an optional name), label, text or testId.',
  oneOf: [
    object({ role: string(), name: string() }, ['role']),
    object({ label: string() }),
    object({ text: string() }),
    object({ testId: string() }),
  ],
};

const CONDITION = {
  description: 'Exactly one condition: text, count, path, requests or outcome.',
  oneOf: [
    object({ text: string(), within: LOCATOR, absent: { const: true } }, ['text']),
    object({ count: object({ of: LOCATOR, is: count, atLeast: count, atMost: count }, ['of']) }),
    object({ path: object({ is: string('^/'), isNot: string('^/') }, []) }),
    object({
      requests: object(
        {
          key: string('^[A-Z]+ /'),
          status: { enum: ['2xx', '3xx', '4xx', '5xx', 'failed'] },
          is: count,
          atLeast: count,
          atMost: count,
        },
        ['key'],
      ),
    }),
    object({ outcome: { enum: ['accepted', 'refused'] } }),
  ],
};

const APP_CHECK_ID = '^app-[a-z0-9][a-z0-9-]{0,39}$';
const AT = { enum: ['settled', 'end', 'every-step'] };

function header(kind, file, title, description) {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://raw.githubusercontent.com/rough-ride/rough-ride/v${current(kind)}/packages/rough-ride/src/schemas/${file}`,
    title,
    description,
  };
}

const schemaField = {
  description: 'The format version: the rough-ride release that introduced it.',
  type: 'string',
  pattern: VERSION,
};

const config = {
  ...header('config', 'config.schema.json', 'rough-ride config.yaml',
    'Settings in .rough-ride/config.yaml at the git root. Every setting except schema is optional.'),
  ...object(
    {
      schema: schemaField,
      target: object(
        {
          url: {
            description: 'The target. Skips Nuxt detection; trusted once it passes the loopback check.',
            ...string('^https?://'),
          },
          start: {
            description: 'The command --start runs in the git root: a string, or a list run side by side.',
            oneOf: [string(), list(string())],
          },
          startTimeout: {
            description: 'Seconds --start waits for the app to answer.',
            type: 'integer',
            minimum: 1,
            default: 120,
          },
          ready: {
            description: 'A JavaScript expression that replaces the ready wait after every full page load.',
            ...string(),
          },
        },
        [],
      ),
      reset: { description: 'Runs once per flow-running invocation, before the sign-in flow, in the git root.', ...string() },
      browser: { description: 'Pins one browser. --browser beats it.', enum: ['chrome', 'msedge', 'chromium'] },
      exclude: { description: 'Page path patterns no flow may visit.', ...list(string('^/')) },
      allow: object(
        {
          remoteTarget: { description: 'The one non-loopback host the target may use.', ...string() },
          remoteWrites: { description: 'Exact hosts the browser may write to. No wildcards.', ...list(string('^[^*]+$')) },
        },
        [],
      ),
    },
    ['schema'],
  ),
};

const step = (kind, extra = {}) => object({ [kind]: LOCATOR, ...extra });
const flow = {
  ...header('flow', 'flow.schema.json', 'rough-ride flow',
    'A flow in .rough-ride/flows/<name>.yaml: one user goal as a list of steps the runner interprets.'),
  ...object({
    schema: schemaField,
    signedIn: { description: 'Whether the flow runs signed in.', type: 'boolean' },
    steps: list({
      oneOf: [
        object({ goto: string('^/') }),
        step('click'),
        step('fill', { value: string() }),
        step('select', { value: string() }),
        step('check'),
        step('press', { key: string() }),
        step('expect'),
      ],
    }),
  }),
};

const request = (withN) => string(withN ? '^[A-Z]+ /.* #[0-9]+$' : '^[A-Z]+ /');
const page = string('^/');
const testCheck = {
  oneOf: [
    { enum: GENERIC_CHECKS },
    object(
      {
        id: string(APP_CHECK_ID),
        at: AT,
        when: object({ outcome: { enum: ['told', 'refused', 'accepted'] } }, []),
        assert: CONDITION,
        spec: string(NAME),
        because: string(LINE_160),
      },
      ['id', 'at', 'assert', 'spec', 'because'],
    ),
  ],
};

const test = {
  ...header('tests', 'test.schema.json', 'rough-ride regression test',
    'A regression test in .rough-ride/tests/<name>.yaml: one attack on one flow and the checks it failed.'),
  ...object(
    {
      schema: schemaField,
      flow: string(NAME),
      attack: {
        oneOf: [
          object({ fault: { enum: FAULTS }, sticky: { type: 'boolean' }, request: request(true), page }),
          object(
            {
              badInput: string(NAME),
              page,
              request: request(false),
              field: { oneOf: [string(), object({ name: string(), kind: string() })] },
              limit: { type: 'integer', minimum: 1 },
            },
            ['badInput', 'page', 'field'],
          ),
          object({ timing: { const: 'double-submit' }, request: request(true), page }),
          object({ timing: { const: 'out-of-order' }, page, request: request(false), field: string() }),
          object({ timing: { enum: ['refresh', 'back', 'signed-out-reload'] }, page, entry: { type: 'integer', minimum: 1 } }),
          object({ viewport: { const: 375 } }),
        ],
      },
      checks: list(testCheck),
      context: object({ timezone: string(), locale: string() }),
      found: object(
        {
          finding: string(),
          run: string('^[0-9]{8}-[0-9]{6}-[a-z]+-[a-z0-9]{4}$'),
          runner: string(),
          date: string('^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
          held: object({
            length: count,
            preview: string(),
            cutBy: { oneOf: [{ const: 'maxlength' }, { type: 'null' }] },
          }),
          bodyKind: string(),
        },
        ['finding', 'run', 'runner', 'date'],
      ),
    },
    ['schema', 'flow', 'attack', 'checks', 'context', 'found'],
  ),
};

const accepted = {
  ...header('accepted', 'accepted.schema.json', 'rough-ride accepted.yaml',
    'Findings a person accepted, keyed by page, step, action and check. People write this file; the runner never does.'),
  ...object({
    schema: schemaField,
    accepted: list(
      object({
        page,
        step: { enum: STEP_KINDS },
        action: string(),
        check: string(),
        because: string('^[^\\r\\n]{1,200}$'),
      }),
    ),
  }),
};

const planCheck = object(
  {
    id: string(APP_CHECK_ID),
    flow: string(NAME),
    when: object(
      {
        attack: { enum: ['fault', 'bad-input', 'timing', 'viewport'] },
        point: request(false),
        field: LOCATOR,
        ids: list(string()),
        outcome: { enum: ['told', 'refused', 'accepted'] },
      },
      ['attack'],
    ),
    at: AT,
    assert: CONDITION,
    spec: string(NAME),
    quote: string(),
    because: string(LINE_160),
  },
  ['id', 'flow', 'when', 'at', 'assert', 'spec', 'quote', 'because'],
);
const noFlow = list(object({ file: string(), page, why: string(LINE_160) }, ['file', 'why']));
const planInput = object(
  {
    attacks: list({
      oneOf: [
        object({ flow: string(NAME), because: string(LINE_160), fault: { enum: FAULTS }, request: request(true), oneShot: { const: true } }, ['flow', 'because', 'fault', 'request']),
        object({
          flow: string(NAME),
          because: string(LINE_160),
          badInputs: { type: 'integer', minimum: 1 },
          form: { oneOf: [request(false), object({ submit: LOCATOR })] },
        }),
        object({ flow: string(NAME), because: string(LINE_160), viewport: { const: 375 } }),
      ],
    }),
    checks: list(planCheck),
    noFlow,
  },
  [],
);
const link = {
  oneOf: [
    object({ file: string(), endpoint: string(), because: string(LINE_160) }),
    object({ file: string(), flow: string(NAME), because: string(LINE_160) }),
    object({ file: string(), page, entry: { const: 'in-app' }, because: string(LINE_160) }, ['file', 'page', 'because']),
  ],
};
const sha256 = string('^[0-9a-f]{64}$');
const plan = {
  ...header('plan', 'plan.schema.json', 'rough-ride plan.json',
    'The attack plan a run used, as runs/<id>/plan.json. input is the plan the adversary wrote, which carries no schema key.'),
  ...object(
    {
      schema: schemaField,
      run: string('^[0-9]{8}-[0-9]{6}-[a-z]+-[a-z0-9]{4}$'),
      tier: { enum: ['quick', 'standard'] },
      runner: string(),
      base: object({ ref: string(), sha: string() }),
      digest: string(),
      spec: list(object({ name: string(NAME), sha256, bytes: count })),
      flows: { description: 'The sha256 of every flow the run attacked, by name.', type: 'object', additionalProperties: sha256 },
      links: object({ input: list(link), accepted: list(link), rejected: list(link) }),
      flowSaves: list(object({ name: string(NAME), item: object({ file: string(), page, entry: string() }, ['file']), outcome: string() })),
      input: planInput,
      entries: list(object({ path: string(), status: string(), attackIds: list(string()), why: string() }, ['path', 'status'])),
      checks: list(object({ id: string(APP_CHECK_ID), status: string(), why: string() }, ['id', 'status'])),
      noFlow,
    },
    ['schema', 'run', 'tier', 'runner', 'input'],
  ),
};

for (const [file, schema] of Object.entries({
  'config.schema.json': config,
  'flow.schema.json': flow,
  'test.schema.json': test,
  'accepted.schema.json': accepted,
  'plan.schema.json': plan,
})) {
  writeFileSync(new URL(file, SCHEMAS), JSON.stringify(schema, null, 2) + '\n');
}
