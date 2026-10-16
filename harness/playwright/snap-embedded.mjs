// The board embedded in a running code-conductor (a scratch instance, never your
// own): cc's bridge mirrors its theme onto the plugin frame, the host's Geist fonts
// load under the plugin's CSP, the frame follows cc's sidebar toggle and the OS
// (cc on "system") live without reloading, and using the board adds no history
// entry to cc. The plugin must already be enabled and started in that cc, with
// PROJECT seeded through cc's plugin proxy; docs/architecture.md → "Verifying
// embedded" has the steps.
//   CC_URL=http://127.0.0.1:<port> PROJECT=<p> [PROJECT2=<q>] node harness/playwright/snap-embedded.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withPage } from '../../../code-playwright/browser.mjs';
import { sel } from './kanban-ui.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const { CC_URL, PROJECT, PROJECT2 } = process.env;
if (!CC_URL || !PROJECT) throw new Error('set CC_URL (a scratch cc) and PROJECT (a project seeded on its board)');
const PLUGIN = '/plugins/code-kanban/';

// Console errors and warnings from the plugin's own frame. Embedded, the host URLs
// resolve, so nothing at all is expected.
function frameConsole(context) {
  const seen = [];
  context.on('console', (msg) => {
    const url = msg.location()?.url ?? '';
    if (['error', 'warning'].includes(msg.type()) && url.includes(PLUGIN)) seen.push(`[${msg.type()}] ${msg.text()} (${url})`);
  });
  return { assertClean: (label) => assert.deepEqual(seen, [], `${label}: console output from the plugin frame`) };
}

async function openBoard(page) {
  await page.goto(`${CC_URL}/#plugin/code-kanban/`, { waitUntil: 'domcontentloaded' });
  const handle = await page.waitForSelector(`iframe[data-plugin-frame][src^="${PLUGIN}"]`, { state: 'attached', timeout: 20_000 });
  const frame = await handle.contentFrame();
  await frame.waitForSelector(sel.project, { timeout: 20_000 });
  await frame.selectOption(sel.project, PROJECT);
  await frame.waitForSelector(`${sel.board}:not([aria-busy]):not([data-loading])`, { timeout: 10_000 });
  await frame.waitForSelector(sel.tiles, { timeout: 10_000 });
  return frame;
}

const frameTheme = (frame) => frame.evaluate(() => ({
  dark: document.documentElement.classList.contains('dark'),
  ccTheme: document.documentElement.getAttribute('data-cc-theme'),
  body: getComputedStyle(document.body).backgroundColor,
  marker: window.__marker ?? null,
}));
const parentDark = (page) => page.evaluate(() => document.documentElement.classList.contains('dark'));
const settled = (frame) => frame.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5_000 });

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });

  await withPage(async (page, { context }) => {
    const guard = frameConsole(context);
    const frame = await openBoard(page);

    // The bridge has mirrored cc's resolved theme before the page painted.
    const first = await frameTheme(frame);
    assert.equal(first.dark, await parentDark(page), 'the frame matches cc');
    assert.equal(first.ccTheme, first.dark ? 'dark' : 'light', 'data-cc-theme names the resolved theme');

    // The host's fonts load under the plugin's CSP (font-src 'self').
    const fonts = await frame.evaluate(async () => {
      const loaded = await document.fonts.load('12px "Geist Variable"');
      return { loaded: loaded.length, family: getComputedStyle(document.body).fontFamily };
    });
    assert.ok(fonts.loaded > 0, 'Geist Variable loaded in the frame');
    assert.match(fonts.family, /^"?Geist Variable/);
    await page.screenshot({ path: path.join(SHOTS, `embedded-1-${first.dark ? 'dark' : 'light'}.png`) });

    // cc's own sidebar toggle: the frame follows within a second, with no reload.
    await frame.evaluate(() => { window.__marker = 'no-reload'; });
    const toggle = page.getByRole('button', { name: /^(Light|Dark) theme$/ });
    await toggle.click();
    await frame.waitForFunction((was) => document.documentElement.classList.contains('dark') !== was, first.dark, { timeout: 1_000 });
    await settled(frame);
    const flipped = await frameTheme(frame);
    assert.equal(flipped.dark, await parentDark(page));
    assert.equal(flipped.ccTheme, flipped.dark ? 'dark' : 'light');
    assert.equal(flipped.marker, 'no-reload', 'the frame was not reloaded');
    assert.notEqual(flipped.body, first.body, 'the frame background changed');
    await page.screenshot({ path: path.join(SHOTS, `embedded-2-${flipped.dark ? 'dark' : 'light'}.png`) });
    await toggle.click();
    await frame.waitForFunction((was) => document.documentElement.classList.contains('dark') === was, first.dark, { timeout: 1_000 });

    // History: opening a card, switching project and closing add no cc history
    // entry, and cc's URL stays on the plugin.
    const before = await page.evaluate(() => history.length);
    await frame.click(sel.tiles);
    await frame.waitForSelector(sel.dialog, { timeout: 10_000 });
    await frame.waitForSelector(`${sel.dialog} section h3`, { timeout: 10_000 });
    await settled(frame);
    await page.screenshot({ path: path.join(SHOTS, 'embedded-3-card.png') });
    await page.keyboard.press('Escape');
    await frame.waitForSelector(sel.dialog, { state: 'detached', timeout: 10_000 });
    if (PROJECT2) {
      await frame.selectOption(sel.project, PROJECT2);
      await frame.waitForSelector(`${sel.board}:not([aria-busy]):not([data-loading])`, { timeout: 10_000 });
      await frame.selectOption(sel.project, PROJECT);
      await frame.waitForSelector(`${sel.board}:not([aria-busy]):not([data-loading])`, { timeout: 10_000 });
    }
    assert.equal(await page.evaluate(() => history.length), before, 'no history entry added');
    assert.match(await page.evaluate(() => location.hash), /^#plugin\/code-kanban\//);
    guard.assertClean('embedded, cc toggle');
    console.log(`embedded: theme mirrored (${first.ccTheme}), fonts loaded, follows cc's toggle live, history untouched${PROJECT2 ? ' across a project switch' : ''}`);
  }, { headless: true, viewport: { width: 1440, height: 900 } });

  // cc on "system" (a fresh context has no stored choice): an OS flip reaches the
  // frame through cc.
  await withPage(async (page, { context }) => {
    const guard = frameConsole(context);
    await page.emulateMedia({ colorScheme: 'light' });
    const frame = await openBoard(page);
    assert.equal((await frameTheme(frame)).ccTheme, 'light');
    await frame.evaluate(() => { window.__marker = 'no-reload'; });
    await page.emulateMedia({ colorScheme: 'dark' });
    await frame.waitForFunction(() => document.documentElement.getAttribute('data-cc-theme') === 'dark', null, { timeout: 1_000 });
    const dark = await frameTheme(frame);
    assert.equal(dark.dark, true);
    assert.equal(dark.marker, 'no-reload');
    await settled(frame);
    await page.screenshot({ path: path.join(SHOTS, 'embedded-4-system-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    await frame.waitForFunction(() => document.documentElement.getAttribute('data-cc-theme') === 'light', null, { timeout: 1_000 });
    guard.assertClean('embedded, system theme');
    console.log('embedded: follows the OS live while cc is on system');
  }, { headless: true, viewport: { width: 1440, height: 900 } });
}

main().catch((e) => { console.error(e); process.exit(1); });
