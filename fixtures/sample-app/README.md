# Sample app (throwaway)

A small notes app that rough-ride's tests attack. Disposable: not a benchmark app, not production code.

- Frontend: Nuxt 4 on http://localhost:3731, with server-side rendering.
- API: FastAPI with SQLite on http://127.0.0.1:8731/api. The browser calls it cross-origin and the Nuxt server calls it during rendering, like the real target apps.
- Sign in with `demo@example.com` / `demo-password`.

The ports are unusual on purpose: on this machine port 8000 belongs to another local app.

## Run it

```sh
npm install          # Node workspaces; uv installs the API's Python deps on first run
npm run dev          # API and frontend together; Ctrl-C stops both
npm run db:reset     # back to the 5 seed notes (also POST /api/test/reset)
npm run test:e2e     # 5 Playwright tests on the installed Chrome; starts its own servers
```

Stop any `npm run dev` before `npm run test:e2e`: the tests start their own servers and refuse to reuse a running one.

## Flows

| Flow | Page | Requests |
|---|---|---|
| Sign in | `/login` | `POST /api/login` from the browser |
| List notes | `/notes` | `GET /api/notes` from the Nuxt server on a full page load, from the browser on in-app navigation |
| Search as you type | `/notes` | `GET /api/notes?q=` from the browser, debounced, stale responses ignored |
| Create a note | `/notes/new` | `POST /api/notes` from the browser |

The notes page's load error lives in `frontend/app/components/LoadErrorPanel.vue`, rendered as `<LazyLoadErrorPanel>`, so the browser fetches it only on the error path. Added for the module-tracing prototype; the markup is unchanged.

## Planted bugs

`BUGS` picks them: `all` (default), `none`, or a comma list. It works for `npm run dev` and `npm run test:e2e`.

| Bug | Where | Shows up when | Correct variant |
|---|---|---|---|
| `stuck-spinner` | `frontend/app/pages/login.vue` | `POST /api/login` fails with anything but 401: spinner forever, button disabled, no message, unhandled rejection | message shown, button re-enabled, retry works |
| `double-submit` | `frontend/app/pages/notes/new.vue` | Save is double-clicked: two notes are created | one note |
| `cleared-form` | `frontend/app/pages/notes/new.vue` | `POST /api/notes` fails: message shown, but title and body are emptied | values kept |
| `stale-search` | `frontend/app/pages/notes/index.vue` | An older search answer arrives after a newer one: the older results replace the newer | stale answers ignored |

Switch on one bug at a time when measuring. With `all`, `cleared-form` hides `double-submit`: the first submit empties the required title, so the browser blocks the second submit.

The 5 e2e tests pass on every variant: none of them injects a fault or double-clicks.
