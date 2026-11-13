// Reference checks: node benchmark/comparison/reference.mjs [lane]
// For each feature, builds its clean variant and each buggy variant, then runs
// every check of that feature against each. A check passes when the app
// behaves as the request asks. Expected: a bug's own check fails on its
// variant and passes everywhere else. Never shown to any arm.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BUGS, DEMO, FEATURES, lanePorts, materializeVariant, REPO, RESULTS, seed, sh, startApp } from './lib.mjs';

// The same Playwright that rough-ride ships with.
const { chromium } = createRequire(path.join(REPO, 'packages/rough-ride/package.json'))('playwright-core');

async function signedIn(browser, ports) {
  const context = await browser.newContext();
  const res = await context.request.post(`http://localhost:${ports.api}/api/auth/login`, { data: { email: DEMO.DEMO_EMAIL, password: DEMO.DEMO_PASSWORD } });
  if (!res.ok()) throw new Error(`login ${res.status()}`);
  return context;
}

// Nuxt renders on the server first; acting before the client takes over is lost.
async function open(context, url) {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => !!document.querySelector('#__nuxt')?.__vue_app__);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  return page;
}

const api = async (context, ports, p) => (await context.request.get(`http://localhost:${ports.api}/api${p}`)).json();

const CHECKS = {
  // A failed stats load says so instead of claiming there are no harvests.
  'error-shown-as-empty': async (context, ports) => {
    const page = await open(context, `http://localhost:${ports.web}/stats`);
    await page.getByText('Weight by plant and month').waitFor();
    await page.route('**/api/stats/harvests**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"Internal Server Error"}' }));
    await page.getByLabel('From').fill('2026-02-01');
    await page.waitForTimeout(2500);
    const empty = await page.getByText('No harvests in this range').isVisible();
    const alert = await page.getByRole('alert').count();
    return { pass: !empty && alert > 0, observed: { emptyStateShown: empty, alerts: alert } };
  },
  // The To date is included: a harvest on 2026-09-30 counts when To is 2026-09-30.
  'to-date-excluded': async (context, ports) => {
    const s = await api(context, ports, '/stats/harvests?from=2026-01-01&to=2026-09-30');
    return { pass: s.total_grams === 2600, observed: { total_grams: s.total_grams, expected: 2600 } };
  },
  // A search with an apostrophe answers normally.
  'search-quote-crash': async (context, ports) => {
    const res = await context.request.get(`http://localhost:${ports.api}/api/journal?q=${encodeURIComponent("don't")}`);
    return { pass: res.status() === 200, observed: { status: res.status() } };
  },
  // A failed save keeps the typed text.
  'failed-save-clears-text': async (context, ports) => {
    const plants = await api(context, ports, '/plants');
    const tomato = plants.find((p) => p.name === 'Tomato');
    const page = await open(context, `http://localhost:${ports.web}/plants/${tomato.id}`);
    const box = page.getByLabel('Entry');
    await box.fill('Picked the first ripe fruit.');
    await page.route('**/api/journal', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"Internal Server Error"}' }) : r.continue()));
    await page.getByRole('button', { name: 'Add entry' }).click();
    await page.waitForTimeout(2500);
    const value = await box.inputValue();
    return { pass: value === 'Picked the first ripe fruit.', observed: { textAfterFailedSave: value } };
  },
  // A double click on Water now records one watering.
  'water-now-twice': async (context, ports) => {
    const beds = await api(context, ports, '/beds');
    const north = beds.find((b) => b.name === 'North bed');
    const before = (await api(context, ports, `/waterings?bed_id=${north.id}`)).length;
    const page = await open(context, `http://localhost:${ports.web}/beds`);
    await page.route('**/api/waterings', async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue(); });
    await page.getByRole('button', { name: 'Water now North bed' }).dblclick();
    await page.waitForTimeout(3000);
    const after = (await api(context, ports, `/waterings?bed_id=${north.id}`)).length;
    return { pass: after - before === 1, observed: { added: after - before } };
  },
  // A negative amount is refused with a reason and not saved.
  'negative-litres': async (context, ports) => {
    const beds = await api(context, ports, '/beds');
    const north = beds.find((b) => b.name === 'North bed');
    const page = await open(context, `http://localhost:${ports.web}/beds`);
    await page.getByRole('button', { name: 'Record past watering for North bed' }).click();
    await page.getByLabel('Litres').fill('-5');
    await page.getByRole('button', { name: 'Save watering' }).click();
    await page.waitForTimeout(2000);
    const list = await api(context, ports, `/waterings?bed_id=${north.id}`);
    const saved = list.some((w) => w.litres < 0);
    return { pass: !saved, observed: { negativeSaved: saved } };
  },
};

async function main([laneText = '3']) {
  const lane = Number(laneText);
  const ports = lanePorts(lane);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const rows = [];
  try {
    for (const feature of FEATURES) {
      for (const bug of [...BUGS[feature], 'clean']) {
        const v = { feature, bug };
        const repo = materializeVariant(v, lane, path.join(process.env.BENCH_WORK, `reference-${feature}-${bug}`));
        const stop = await startApp(repo, lane, path.join(process.env.BENCH_WORK, `reference-${feature}-${bug}.log`));
        try {
          for (const check of BUGS[feature]) {
            // Each check gets fresh data, so one check's writes never feed another.
            await seedFresh(repo, lane, feature);
            const context = await signedIn(browser, ports);
            let r;
            try { r = await CHECKS[check](context, ports); } catch (e) { r = { pass: null, error: String(e.message ?? e).split('\n')[0] }; }
            await context.close();
            const expected = bug === check ? false : true;
            rows.push({ variant: `${feature}/${bug}`, check, ...r, expected, asExpected: r.pass === expected });
            console.log(`${feature}/${bug} :: ${check}: pass=${r.pass} expected=${expected} ${JSON.stringify(r.observed ?? r.error)}`);
          }
        } finally { await stop(); }
      }
    }
  } finally { await browser.close(); }
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, 'reference.json'), JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2) + '\n');
  const bad = rows.filter((r) => !r.asExpected);
  console.log(bad.length ? `NOT AS EXPECTED: ${bad.length}` : 'all reference checks as expected');
  return bad.length ? 1 : 0;
}

// Resets the database while the app runs, then seeds it again.
async function seedFresh(repo, lane, feature) {
  sh('npm', ['run', 'reset'], { cwd: repo });
  try { await seed(lane, feature); } catch { await new Promise((ok) => setTimeout(ok, 3000)); sh('npm', ['run', 'reset'], { cwd: repo }); await seed(lane, feature); }
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
