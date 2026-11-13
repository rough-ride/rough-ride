// Held-out reference checks: node benchmark/comparison/heldout-reference.mjs [lane]
// The same shape as reference.mjs, over the held-out variants. For each
// feature, builds its clean variant and each held-out variant, then runs every
// held-out check of that feature against each. A check passes when the app
// behaves as the request (or ordinary expectations) asks. Expected: a check
// fails on its own variant and passes on the clean one and on its sibling.
// Never shown to any arm.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEMO, FEATURES, lanePorts, materializeVariant, REPO, RESULTS, seed, sh, startApp } from './lib.mjs';

const { chromium } = createRequire(path.join(REPO, 'packages/rough-ride/package.json'))('playwright-core');

const HELDOUT = {
  'harvest-stats': ['hx1', 'hx2'],
  'plant-journal': ['hx3', 'hx4'],
  'watering-log': ['hx5', 'hx6'],
};

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const fault500 = { status: 500, contentType: 'application/json', body: '{"detail":"Internal Server Error"}' };

async function signedIn(browser, ports, options = {}) {
  const context = await browser.newContext(options);
  const res = await context.request.post(`http://localhost:${ports.api}/api/auth/login`, { data: { email: DEMO.DEMO_EMAIL, password: DEMO.DEMO_PASSWORD } });
  if (!res.ok()) throw new Error(`login ${res.status()}`);
  return context;
}

async function hydrated(page) {
  await page.waitForFunction(() => !!document.querySelector('#__nuxt')?.__vue_app__);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

// Nuxt renders on the server first; acting before the client takes over is lost.
async function open(context, url) {
  const page = await context.newPage();
  await page.goto(url);
  await hydrated(page);
  return page;
}

const apiUrl = (ports, p) => `http://localhost:${ports.api}/api${p}`;
const get = async (context, ports, p) => (await context.request.get(apiUrl(ports, p))).json();
async function post(context, ports, p, data) {
  const res = await context.request.post(apiUrl(ports, p), { data });
  if (!res.ok()) throw new Error(`POST ${p} ${res.status()} ${await res.text()}`);
  return res.json();
}

const CHECKS = {
  // When an earlier range answers after a later one, the page still shows the later range.
  hx1: async (context, ports) => {
    const page = await open(context, `http://localhost:${ports.web}/stats`);
    await page.getByText('Weight by plant and month').waitFor();
    const seen = [];
    await page.route('**/api/stats/harvests**', async (r) => {
      const to = new URL(r.request().url()).searchParams.get('to');
      seen.push(to);
      await sleep(to === '2026-07-31' ? 200 : 2500);
      await r.continue().catch(() => {});
    });
    await page.getByLabel('From', { exact: true }).fill('2026-07-01');
    await page.waitForTimeout(300);
    await page.getByLabel('To', { exact: true }).fill('2026-07-31');
    await page.waitForTimeout(5000);
    const line = (await page.locator('.results-count').innerText()).trim();
    const total = (await page.locator('#table-heading + .badge').innerText()).trim();
    const pass = line === '2 harvests from 1 Jul 2026 to 31 Jul 2026' && total === '1.65 kg total';
    return { pass, observed: { line, total, requestedTo: seen } };
  },
  // Two plants that share a name keep their own rows in the table.
  hx2: async (context, ports) => {
    const beds = await get(context, ports, '/beds');
    const north = beds.find((b) => b.name === 'North bed');
    const second = await post(context, ports, '/plants', { name: 'Tomato', variety: "Gardener's Delight", bed_id: north.id, planted_on: '2026-04-20' });
    await post(context, ports, '/harvests', { plant_id: second.id, weight_grams: 500, harvested_on: '2026-08-20' });
    const page = await open(context, `http://localhost:${ports.web}/stats?from=2026-01-01&to=2026-12-31`);
    await page.getByText('Weight by plant and month').waitFor();
    const rows = await page.locator('.stats-table tbody tr').evaluateAll((trs) => trs.map((tr) => {
      const cells = [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
      return { plant: cells[0], total: cells[cells.length - 1] };
    }));
    const tomatoes = rows.filter((r) => r.plant.startsWith('Tomato')).map((r) => `${r.plant} = ${r.total}`).sort();
    const want = ["Tomato · Gardener's Delight = 500 g", 'Tomato · Sungold = 1.05 kg'];
    return { pass: JSON.stringify(tomatoes) === JSON.stringify(want), observed: { tomatoes, want } };
  },
  // A failed delete leaves the entry in the list and says why.
  hx3: async (context, ports) => {
    const plants = await get(context, ports, '/plants');
    const tomato = plants.find((p) => p.name === 'Tomato');
    const page = await open(context, `http://localhost:${ports.web}/plants/${tomato.id}`);
    page.on('dialog', (d) => d.accept());
    await page.getByText('Tied the stems to canes.').waitFor();
    await page.route('**/api/journal/*', (r) => (r.request().method() === 'DELETE' ? r.fulfill(fault500) : r.continue()));
    await page.getByRole('button', { name: 'Delete entry from 2 Jul 2026' }).click();
    await page.waitForTimeout(2500);
    const stillListed = await page.getByText('Tied the stems to canes.').isVisible();
    const alerts = await page.getByRole('alert').count();
    return { pass: stillListed && alerts > 0, observed: { stillListed, alerts } };
  },
  // Harvest counts and weights are unchanged by journal entries (Tomato: 3 harvests, 1350 g).
  hx4: async (context, ports) => {
    const list = await get(context, ports, '/plants');
    const tomato = list.find((p) => p.name === 'Tomato');
    const detail = await get(context, ports, `/plants/${tomato.id}`);
    const observed = {
      list: { harvest_count: tomato.harvest_count, harvest_grams: tomato.harvest_grams, journal_count: tomato.journal_count },
      detail: { harvest_count: detail.harvest_count, harvest_grams: detail.harvest_grams, harvests_listed: detail.harvests?.length },
    };
    const ok = (o) => o.harvest_count === 3 && o.harvest_grams === 1350;
    return { pass: ok(observed.list) && ok(observed.detail) && tomato.journal_count === 2, observed };
  },
  // At 375px the past-watering form fits its bed card and its fields are wide enough to use.
  hx5: async (_context, ports, browser) => {
    const context = await signedIn(browser, ports, { viewport: { width: 375, height: 812 } });
    try {
      const page = await open(context, `http://localhost:${ports.web}/beds`);
      await page.getByRole('button', { name: 'Record past watering for North bed' }).click();
      await page.locator('.water-form').waitFor();
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const form = document.querySelector('.water-form');
        const card = form.parentElement.closest('li') ?? form.parentElement;
        const parts = [form, ...form.querySelectorAll('input, button, label')];
        return {
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          formRight: Math.round(Math.max(...parts.map((e) => e.getBoundingClientRect().right))),
          cardRight: Math.round(card.getBoundingClientRect().right),
          inputWidths: [...form.querySelectorAll('input')].map((e) => Math.round(e.getBoundingClientRect().width)),
        };
      });
      const fits = m.formRight <= m.cardRight + 1 && m.formRight <= m.viewport + 1 && m.scrollWidth <= m.viewport;
      const usable = m.inputWidths.length === 2 && m.inputWidths.every((w) => w >= 120);
      return { pass: fits && usable, observed: m };
    } finally { await context.close(); }
  },
  // A bed chosen in the Waterings filter is still chosen after a reload.
  hx6: async (context, ports) => {
    const page = await open(context, `http://localhost:${ports.web}/waterings`);
    const select = page.getByLabel('Bed', { exact: true });
    await select.selectOption({ label: 'Shade corner' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.reload();
    await hydrated(page);
    const chosen = await select.evaluate((s) => s.options[s.selectedIndex]?.text.trim());
    const rows = await page.locator('table.table tbody tr').count();
    return { pass: chosen === 'Shade corner' && rows === 1, observed: { url: page.url().replace(/^https?:\/\/[^/]+/, ''), chosen, rows } };
  },
};

// Resets the database while the app runs, then seeds it again.
async function seedFresh(repo, lane, feature) {
  sh('npm', ['run', 'reset'], { cwd: repo });
  try { await seed(lane, feature); } catch { await sleep(3000); sh('npm', ['run', 'reset'], { cwd: repo }); await seed(lane, feature); }
}

async function main([laneText = '5']) {
  const lane = Number(laneText);
  const ports = lanePorts(lane);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const rows = [];
  try {
    for (const feature of FEATURES) {
      for (const bug of [...HELDOUT[feature], 'clean']) {
        const v = { feature, bug };
        const repo = materializeVariant(v, lane, path.join(process.env.BENCH_WORK, `heldout-${feature}-${bug}`));
        const stop = await startApp(repo, lane, path.join(process.env.BENCH_WORK, `heldout-${feature}-${bug}.log`));
        try {
          for (const check of HELDOUT[feature]) {
            // Each check gets fresh data, so one check's writes never feed another.
            await seedFresh(repo, lane, feature);
            const context = await signedIn(browser, ports);
            let r;
            try { r = await CHECKS[check](context, ports, browser); } catch (e) { r = { pass: null, error: String(e.message ?? e).split('\n')[0] }; }
            await context.close();
            const expected = bug !== check;
            rows.push({ variant: `${feature}/${bug}`, check, ...r, expected, asExpected: r.pass === expected });
            console.log(`${feature}/${bug} :: ${check}: pass=${r.pass} expected=${expected} ${JSON.stringify(r.observed ?? r.error)}`);
          }
        } finally { await stop(); }
      }
    }
  } finally { await browser.close(); }
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, 'heldout-reference.json'), JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2) + '\n');
  const bad = rows.filter((r) => !r.asExpected);
  console.log(bad.length ? `NOT AS EXPECTED: ${bad.length}` : 'all held-out reference checks as expected');
  return bad.length ? 1 : 0;
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
