// Visual-verification harness for the code-kanban web GUI. Boots the plugin's
// own server with an isolated PROJECTS_ROOT, seeds a project through the REAL
// /api/board/* routes (so board.js / the mutex are exercised), then drives the
// golden path with a real browser and captures screenshots:
//   1. the populated board (5 columns + epics rollup)
//   2. a card's detail panel (Goal / Acceptance / Logbook + move + edit)
//   3. the board after a legal move (status surfaces the move)
// Reuses withPage/waitForServer from the shared code-playwright harness — no
// chromium/launch logic here. Run: node harness/playwright/snap-gui.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { withPage, waitForServer } from '../../../code-playwright/browser.mjs';
import { bootKanban } from './boot-kanban.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PROJECT = 'demo';

async function ensureShotsDir() {
  await fs.mkdir(SHOTS, { recursive: true });
}

// Seed a project through the real API (goes through board.js — the single
// writer). In standalone mode (no CONDUCTOR_URL) the project list is the set of
// top-level dirs under PROJECTS_ROOT, so create one so `demo` is selectable.
async function seed(base, projectsRoot) {
  await fs.mkdir(path.join(projectsRoot, PROJECT), { recursive: true });
  const api = (p, opts = {}) => fetch(base + p, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then((r) => r.json());

  // Every seed step must succeed. A silently-refused step (illegal transition,
  // a dropped field) is exactly what left the In Progress column empty and the
  // priority/owner badges unrendered before — so fail loudly on any {ok:false}.
  const call = async (p, opts, label) => {
    const b = await api(p, opts);
    if (!b || b.ok === false) {
      throw new Error(`seed step "${label}" refused: ${JSON.stringify(b)}`);
    }
    return b;
  };

  await call(`/api/board/${PROJECT}/epics`, { method: 'POST', body: { slug: 'auth', title: 'Auth flow', goal: 'Sign-in + sessions' } }, 'epic auth');
  await call(`/api/board/${PROJECT}/epics`, { method: 'POST', body: { slug: 'search', title: 'Search', goal: 'Full-text search' } }, 'epic search');

  // fileTask does NOT accept priority (it is 0 at filing by design); set it via
  // updateTask below so the priority badge renders.
  const a = await call(`/api/board/${PROJECT}/tasks`, { method: 'POST', body: { title: 'Design login screen', goal: 'Email + password form', acceptance: ['Matches design spec', 'Accessible labels'], epic: 'auth' } }, 'file a');
  const b = await call(`/api/board/${PROJECT}/tasks`, { method: 'POST', body: { title: 'Hash passwords with argon2', goal: 'No plaintext at rest', epic: 'auth' } }, 'file b');
  const c = await call(`/api/board/${PROJECT}/tasks`, { method: 'POST', body: { title: 'Build search index', goal: 'Inverted index over docs', epic: 'search' } }, 'file c');
  const d = await call(`/api/board/${PROJECT}/tasks`, { method: 'POST', body: { title: 'Triage: spike caching layer', goal: 'Decide redis vs in-memory' } }, 'file d');

  await call(`/api/board/${PROJECT}/tasks/${a.id}`, { method: 'PATCH', body: { priority: 2 } }, 'priority a');
  await call(`/api/board/${PROJECT}/tasks/${b.id}`, { method: 'PATCH', body: { priority: 3 } }, 'priority b');
  await call(`/api/board/${PROJECT}/tasks/${c.id}`, { method: 'PATCH', body: { priority: 1 } }, 'priority c');

  // Spread cards across columns via LEGAL transitions. b reaches in-progress
  // through triage→todo→in-progress (NOT triage→in-progress, which is illegal),
  // so the In Progress column is populated and b carries an owner badge (owner
  // is set only on entering in-progress). a→todo, c→backlog, d stays in triage.
  await call(`/api/board/${PROJECT}/tasks/${a.id}/move`, { method: 'POST', body: { to: 'todo' } }, 'move a → todo');
  await call(`/api/board/${PROJECT}/tasks/${b.id}/move`, { method: 'POST', body: { to: 'todo' } }, 'move b → todo');
  await call(`/api/board/${PROJECT}/tasks/${b.id}/move`, { method: 'POST', body: { to: 'in-progress' } }, 'move b → in-progress');
  await call(`/api/board/${PROJECT}/tasks/${c.id}/move`, { method: 'POST', body: { to: 'backlog' } }, 'move c → backlog');
  return { a, b, c, d };
}

async function main() {
  await ensureShotsDir();
  const srv = await bootKanban({ sandbox: { dirs: { PROJECTS_ROOT: 'root' } }, silent: true });
  try {
    await waitForServer(srv.url);
    const projectsRoot = srv.sandbox.dirs.PROJECTS_ROOT;
    const seeded = await seed(srv.url, projectsRoot);

    await withPage(async (page) => {
      // 1. Board: load and wait for cards to render. (app.js auto-selects the
      //    first project and loads the board; <option> elements are always
      //    "hidden" to Playwright, so wait on the rendered cards instead.)
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#project-select', { timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector('#project-select')?.value === 'demo', { timeout: 10_000 });
      await page.waitForSelector('.card', { timeout: 10_000 });
      await page.waitForSelector('.epic-row', { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-1-board.png'), fullPage: true });
      console.log('snapped board');

      // 2. Card detail: click the first card, wait for the overlay.
      await page.click('.card');
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.waitForSelector('.logbook li', { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-2-detail.png'), fullPage: true });
      console.log('snapped detail');

      // 3. Legal move from the detail panel: pick the first legal target, move.
      const moveSelect = await page.locator('#detail-overlay .move-row select');
      const target = await moveSelect.first().evaluate((sel) => {
        const opt = [...sel.options].find((o) => o.value);
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        return opt ? opt.value : null;
      });
      if (target) {
        await page.click('#detail-overlay .move-row button');
        // The move handler closes the detail overlay and reloads the board.
        await page.waitForSelector('#detail-overlay', { state: 'hidden', timeout: 10_000 });
        await page.waitForSelector('.card', { timeout: 10_000 });
        await page.screenshot({ path: path.join(SHOTS, 'gui-3-after-move.png'), fullPage: true });
        console.log(`snapped after-move (moved to ${target})`);
      } else {
        console.log('no legal move target on first card — skipping move screenshot');
      }
    }, { headless: true, viewport: { width: 1440, height: 900 } });
  } finally {
    await srv.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });