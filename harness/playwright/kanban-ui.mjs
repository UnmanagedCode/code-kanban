// Shared selectors and steps for driving the board UI. Selectors use roles and
// accessible names, plus the stable data-* hooks the components carry for the
// harness (listed in .wiki/architecture/gui-seam-contract.md), never class names.
import assert from 'node:assert/strict';

export const sel = {
  project: '#project-select',
  board: 'section[aria-label="Board"]',
  lane: (state) => `[data-lane="${state}"]`,
  laneHead: (state) => `[data-lane="${state}"] [data-lane-head]`,
  laneBody: (state) => `[data-lane="${state}"] [data-lane-body]`,
  tiles: '[data-card-id]',
  tile: (id) => `[data-card-id="${id}"]`,
  badge: (kind) => `[data-badge="${kind}"]`,
  epicsPane: 'section[aria-labelledby="epics-heading"]',
  epicRows: '[data-epic-slug]',
  epicRow: (slug) => `[data-epic-slug="${slug}"]`,
  pills: '[data-rollup]',
  dialog: '[role="dialog"]',
  // A dialog section by its heading text.
  section: (label) => `[role="dialog"] section:has(> h3:text-is("${label}"))`,
};

/** Waits until the board shows `project`'s lists (not the loading placeholders). */
export async function waitBoard(page) {
  await page.waitForSelector(`${sel.board}:not([aria-busy]):not([data-loading])`, { timeout: 10_000 });
  await page.waitForSelector('[data-lane]', { timeout: 10_000 });
}

export async function selectProject(page, name) {
  await page.waitForSelector(sel.project, { timeout: 10_000 });
  await page.selectOption(sel.project, name);
  await page.waitForFunction((v) => document.querySelector('#project-select')?.value === v, name, { timeout: 10_000 });
  await waitBoard(page);
}

/** Clicks Refresh and waits until the reload it started has landed. */
export async function refresh(page) {
  const landed = page.waitForResponse((r) => /\/api\/board\/[^/]+\/epics$/.test(new URL(r.url()).pathname));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await landed;
  await waitBoard(page);
}

/** Waits for the open dialog, its opening animation finished. */
export async function waitDialog(page) {
  const d = page.locator(sel.dialog);
  await d.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('[role="dialog"]');
    return el && el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running');
  }, { timeout: 10_000 });
  return d;
}

/** Waits for the dialog's loaded content (its skeleton gone). */
export async function waitDialogLoaded(page) {
  await waitDialog(page);
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] [data-skeleton]'), { timeout: 10_000 });
}

export async function closeDialog(page) {
  await page.locator(sel.dialog).getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForSelector(sel.dialog, { state: 'detached', timeout: 10_000 });
}

export async function waitDialogClosed(page) {
  await page.waitForSelector(sel.dialog, { state: 'detached', timeout: 10_000 });
}

export async function openCard(page, id) {
  await page.click(sel.tile(id));
  await waitDialogLoaded(page);
}

export async function openEpic(page, slug) {
  await page.locator(sel.epicRow(slug)).getByRole('button', { name: `Open epic ${slug}` }).click();
  await waitDialogLoaded(page);
}

export const statusText = (page) => page.getByRole('status').textContent();

// The two host URLs 404 standalone, and with nosniff the browser also refuses the
// 404 as a script / stylesheet. Those are the only console noise a standalone page
// may make (docs: the plugin-ui host contract's console check).
const HOST_URL = /\/(pluginBridge\.js|pluginTheme\.css)\b/;

/**
 * Collects console errors / warnings and page errors on `context`. `allow` adds
 * patterns a step expects (matched against the text and the source URL).
 * `assertClean()` throws on anything else.
 */
export function consoleGuard(context, { allow = [], hostUrls = true } = {}) {
  const seen = [];
  const allowed = (text, url) => (hostUrls && (HOST_URL.test(text) || HOST_URL.test(url)))
    || allow.some((re) => re.test(text) || re.test(url));
  context.on('console', (msg) => {
    if (!['error', 'warning'].includes(msg.type())) return;
    const url = msg.location()?.url ?? '';
    if (!allowed(msg.text(), url)) seen.push(`[${msg.type()}] ${msg.text()} (${url})`);
  });
  context.on('weberror', (e) => seen.push(`[pageerror] ${e.error()}`));
  return {
    assertClean(label) {
      assert.deepEqual(seen, [], `${label}: unexpected console output`);
    },
  };
}
