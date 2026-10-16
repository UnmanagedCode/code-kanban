// Standalone light/dark: outside code-conductor the page has no host theme, so
// public/theme-init.js follows the OS colour scheme, live, and the fallback
// tokens (frontend/src/cc-theme-fallback.css) keep it legible in both. Flips
// prefers-color-scheme without a reload and checks the page follows; screenshots
// the board and a card in each. Run: node harness/playwright/snap-theme.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withPage, waitForServer } from '../../../code-playwright/browser.mjs';
import { bootKanban } from './boot-kanban.mjs';
import { sel, selectProject, openCard, closeDialog, consoleGuard } from './kanban-ui.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PROJECT = 'demo';

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const srv = await bootKanban({ sandbox: { dirs: { PROJECTS_ROOT: 'root' } }, silent: true });
  try {
    await waitForServer(srv.url);
    await fs.mkdir(path.join(srv.sandbox.dirs.PROJECTS_ROOT, PROJECT), { recursive: true });
    const call = async (p, body) => {
      const r = await fetch(srv.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
      if (!r || r.ok === false) throw new Error(`seed ${p} refused: ${JSON.stringify(r)}`);
      return r;
    };
    await call(`/api/board/${PROJECT}/epics`, { slug: 'auth', title: 'Auth flow' });
    const card = await call(`/api/board/${PROJECT}/cards`, { title: 'Design login screen', goal: 'Email + password form', acceptance: ['Matches design spec'], epic: 'auth', priority: 'HIGH' });
    await call(`/api/board/${PROJECT}/cards`, { title: 'Hash passwords', priority: 'CRITICAL' });
    await call(`/api/board/${PROJECT}/cards/${card.id}/move`, { to: 'todo' });

    await withPage(async (page, { context }) => {
      const guard = consoleGuard(context);
      // Colour transitions (buttons, tiles) run for a moment after a flip.
      const settled = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), { timeout: 5_000 });
      const read = () => page.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        ccTheme: document.documentElement.getAttribute('data-cc-theme'),
        body: getComputedStyle(document.body).backgroundColor,
        lane: getComputedStyle(document.querySelector('[data-lane="todo"]')).borderTopColor,
      }));

      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await selectProject(page, PROJECT);
      await page.evaluate(() => { window.__marker = 'no-reload'; });
      const light = await read();
      assert.equal(light.dark, false, 'light OS → no .dark');
      assert.equal(light.ccTheme, null, 'standalone → no data-cc-theme');
      await page.screenshot({ path: path.join(SHOTS, 'theme-1-light-board.png') });
      await openCard(page, card.id);
      await page.screenshot({ path: path.join(SHOTS, 'theme-2-light-card.png') });
      await closeDialog(page);

      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'), { timeout: 5_000 });
      await settled();
      const dark = await read();
      assert.equal(await page.evaluate(() => window.__marker), 'no-reload', 'followed without a reload');
      assert.notEqual(dark.body, light.body, 'the page background changes');
      assert.notEqual(dark.lane, light.lane, 'the lane accent changes');
      assert.equal(dark.ccTheme, null);
      await page.screenshot({ path: path.join(SHOTS, 'theme-3-dark-board.png') });
      await openCard(page, card.id);
      await page.screenshot({ path: path.join(SHOTS, 'theme-4-dark-card.png') });
      await closeDialog(page);

      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), { timeout: 5_000 });
      await settled();
      assert.deepEqual(await read(), light, 'flipping back restores the light theme');
      assert.ok(await page.locator(sel.tiles).count() > 0);
      console.log(`theme follows the OS live (light bg ${light.body}, dark bg ${dark.body})`);
      guard.assertClean('standalone theme');
    }, { headless: true, viewport: { width: 1440, height: 900 } });
  } finally {
    await srv.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
