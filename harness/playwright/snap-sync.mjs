// Visual verification for the cross-instance Sync dialog + a real end-to-end
// pull. Boots TWO plugin instances (a peer + a local board), seeds the peer with
// cards through the REAL /api/board routes, then drives the local GUI: opens the
// Sync dialog (screenshot 1), pastes the peer's URL, clicks Pull, and captures
// the merged board (screenshot 2). The pull is a genuine backend->backend fetch
// between the two servers on 127.0.0.1 — no stubs. Run:
//   node harness/playwright/snap-sync.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { withPage, waitForServer } from '../../../code-playwright/browser.mjs';
import { bootKanban } from './boot-kanban.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PROJECT = 'demo';

async function seed(base, root, { epics = [], cards = [] } = {}) {
  await fs.mkdir(path.join(root, PROJECT), { recursive: true });
  const call = async (p, opts, label) => {
    const b = await fetch(base + p, {
      headers: { 'content-type': 'application/json' },
      ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then((r) => r.json());
    if (!b || b.ok === false) throw new Error(`seed "${label}" refused: ${JSON.stringify(b)}`);
    return b;
  };
  for (const e of epics) await call(`/api/board/${PROJECT}/epics`, { method: 'POST', body: e }, `epic ${e.slug}`);
  for (const c of cards) await call(`/api/board/${PROJECT}/tasks`, { method: 'POST', body: c }, `card ${c.title}`);
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  // The SSRF guard blocks loopback by default; these instances live on
  // 127.0.0.1, so allow private targets for the harness only.
  const allowPrivate = { CODE_KANBAN_SYNC_ALLOW_PRIVATE: '1' };
  const peer = await bootKanban({ sandbox: { dirs: { PROJECTS_ROOT: 'peer' }, env: allowPrivate }, silent: true });
  const local = await bootKanban({ sandbox: { dirs: { PROJECTS_ROOT: 'local' }, env: allowPrivate }, silent: true });
  try {
    await waitForServer(peer.url);
    await waitForServer(local.url);
    // Peer has an epic + a card under it, so the pull must carry the epic for the
    // card's `epic:` to resolve and its rollup to count on the local board.
    await seed(peer.url, peer.sandbox.dirs.PROJECTS_ROOT, {
      epics: [{ slug: 'auth', title: 'Auth flow', goal: 'Sign-in + sessions' }],
      cards: [{ title: 'Peer card one' }, { title: 'Peer card two' }, { title: 'Peer card three', epic: 'auth' }],
    });
    await seed(local.url, local.sandbox.dirs.PROJECTS_ROOT, { cards: [{ title: 'Local card' }] });

    await withPage(async (page) => {
      await page.goto(local.url + '/', { waitUntil: 'domcontentloaded' });
      await page.selectOption('#project-select', PROJECT);
      await page.waitForSelector('.card', { timeout: 10_000 });

      // Open the Sync dialog and screenshot it (own-URL field + peer field + scope).
      await page.click('#sync-btn');
      await page.waitForSelector('#form-overlay:not(.hidden) input[name="peerUrl"]', { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'sync-1-dialog.png'), fullPage: true });
      console.log('snapped sync dialog');

      // Drive a real pull from the peer.
      await page.fill('input[name="peerUrl"]', peer.url);
      await page.selectOption('select[name="scope"]', 'project');
      await page.click('#form-overlay button[type="submit"]');
      await page.waitForSelector('#form-overlay', { state: 'hidden', timeout: 10_000 });
      // Merged board: 1 local + 3 peer cards = 4, and the peer's 'auth' epic now
      // renders in the epics rollup (proving the epic synced with the cards).
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 4, { timeout: 10_000 });
      await page.waitForSelector('.epic-row', { timeout: 10_000 });
      const epicSynced = await page.evaluate(() => document.querySelector('#epics')?.textContent?.includes('auth'));
      if (!epicSynced) throw new Error('synced epic "auth" did not render in the epics rollup');
      await page.screenshot({ path: path.join(SHOTS, 'sync-2-merged.png'), fullPage: true });
      const status = await page.textContent('#status');
      console.log(`snapped merged board (epic synced) — status: ${status}`);
    }, { headless: true, viewport: { width: 1440, height: 900 } });
  } finally {
    await local.close();
    await peer.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
