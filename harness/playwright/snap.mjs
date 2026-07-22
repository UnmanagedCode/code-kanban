// App-specific screenshot CLI: boot code-kanban, navigate, snap a PNG.
//   node harness/playwright/snap.mjs [pathOrUrl] [outPng]
// Defaults to the future GUI root ("/"); pass an explicit path meanwhile.
// Reuses withPage/waitForServer from the shared harness — no chromium/launch
// logic here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPage, waitForServer } from '../../../code-playwright/browser.mjs';
import { bootKanban } from './boot-kanban.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? '/';
const out = process.argv[3] ?? path.join(__dirname, 'screenshots', `kanban-${Date.now()}.png`);

const srv = await bootKanban();
try {
  const url = new URL(target, srv.url).toString();
  await waitForServer(srv.url);
  await withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: out });
    console.log(`snapped ${url} -> ${out}`);
  }, { headless: true, viewport: { width: 1440, height: 900 } });
} finally {
  await srv.close();
}
