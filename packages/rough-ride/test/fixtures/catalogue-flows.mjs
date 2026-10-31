// Recorded baseline runs for the Attack catalogue tests: two signed-in flows
// that fill the same Title field on /notes/new and post it, and a sign-in flow.

const field = (over = {}) => ({ tag: 'input', type: 'text', inputmode: null, autocomplete: null, role: null, required: true, ariaRequired: false, maxlength: null, minlength: null, min: null, max: null, step: null, pattern: null, multiple: false, readonly: false, disabled: false, contenteditable: false, novalidate: false, visible: true, options: null, held: 'x', ...over });
const button = { tag: 'button', type: 'submit', role: null, ariaPressed: null, ariaChecked: null, ariaExpanded: null };

export const req = (over) => ({ step: 4, method: 'POST', url: 'http://localhost:8731/api/notes', key: 'POST /api/notes #1', resourceType: 'fetch', offsetMs: 10, navigation: false, pagePath: '/notes/new', status: 201, failure: null, mediaType: 'application/json', emptyBody: false, streaming: false, jsonRoot: 'object', credentialed: true, postData: '{"title":"x"}', oversize: false, servedByFault: false, ...over });

const NOTES_STEPS = [{ goto: '/notes' }, { click: { role: 'link', name: 'New note' } }, { fill: { label: 'Title' }, value: 'x' }, { click: { role: 'button', name: 'Save' } }];

export const noteFlow = (name) => ({ name, signedIn: true, steps: NOTES_STEPS });

const NOTE_PAGES = [
  { path: '/notes', step: 1, entry: 'full-load', requests: ['GET /api/notes'], previous: null, method: 'GET' },
  { path: '/notes/new', step: 2, entry: 'in-app', requests: [], previous: '/notes', method: null },
];

// The notes list loads by GET on the first step; Save posts the title.
export const noteRun = ({ requests, pages = NOTE_PAGES } = {}) => ({
  passed: true, failure: null, excluded: null, refused: null, durationMs: 1000, dialogs: [], envFilled: [], aborted: [], pageEvents: [], voided: null, fault: null, endedAfterWindow: false, timing: null, stoppedAt: null, recovery: null, shots: new Map(),
  requests: requests ?? [
    req({ step: 1, method: 'GET', url: 'http://localhost:8731/api/notes', key: 'GET /api/notes #1', pagePath: '/notes', status: 200, jsonRoot: 'array', postData: null, body: [{ id: 1, title: 'x' }] }),
    req({}),
  ],
  pages,
  steps: NOTES_STEPS.map((_, i) => ({ index: i + 1, path: i === 0 ? '/notes' : '/notes/new', label: '', settled: true, settleMs: 0, ...(i === 2 ? { value: 'x', field: field() } : {}), ...(i === 3 ? { control: button } : {}) })),
  formEvents: { submits: [], invalids: [] },
  unique: 'tok12345',
});

const SIGN_IN_STEPS = [{ goto: '/login' }, { fill: { label: 'Email' }, value: 'a@b.co' }, { fill: { label: 'Password' }, value: '${env.PASSWORD}' }, { click: { role: 'button', name: 'Sign in' } }];

export const signInFlow = { name: 'sign-in', signedIn: false, steps: SIGN_IN_STEPS };

export const signInRun = () => ({
  ...noteRun(),
  requests: [req({ url: 'http://localhost:8731/api/login', key: 'POST /api/login #1', pagePath: '/login', status: 200, credentialed: false, postData: '{"email":"a@b.co","password":"pw"}' })],
  pages: [{ path: '/login', step: 1, entry: 'full-load', requests: [], previous: null, method: 'GET' }],
  steps: SIGN_IN_STEPS.map((_, i) => ({ index: i + 1, path: '/login', label: '', settled: true, settleMs: 0, ...(i === 1 ? { value: 'a@b.co', field: field({ type: 'email' }) } : {}), ...(i === 2 ? { value: 'pw', field: field({ type: 'password' }) } : {}), ...(i === 3 ? { control: button } : {}) })),
});
