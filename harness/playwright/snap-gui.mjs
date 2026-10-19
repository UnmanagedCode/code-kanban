// Visual-verification harness for the code-kanban web GUI. Boots the plugin's
// own server with an isolated PROJECTS_ROOT, seeds a project through the REAL
// /api/board/* routes (so board.js / the mutex are exercised), then drives the
// golden path with a real browser and captures screenshots:
//   1. the populated board (5 lanes + epics rollup), 1b. a cross-project epic's detail
//   2. a card's detail (Goal / Acceptance / Logbook + move + edit)
//   3. the board after a legal move (status surfaces the move)
//   4. a landed card's detail showing the stamped Commit field
//   5. the project selection surviving a reload (localStorage restore)
//   6. the plan badge on a card carrying a plan link
//   7. that card's detail showing the Plan section (link + file body) rendered
//      as Markdown (its YAML frontmatter as one verbatim block), light and dark; hostile content inert; the live link opening a
//      popup; 7b. the Raw view, light and dark; the view resetting on reopen
//   8. the board with the "Has plan" filter on (only planned cards remain)
//   9–13. priority badges, "unset" in the detail, the edit and new-card selects
//   14. the edit form's Acceptance textarea prefilled one criterion per line
//   15. the read view after editing acceptance: a renamed criterion, a new
//       one, and the untouched criterion's tick surviving the {replace} round trip
//   16. per-lane scrolling: the overflowing `done` lane scrolls, the page doesn't
//   17. the lane header staying put while its body scrolls, and lanes scrolling
//       independently of one another
//   18. a lane's scroll offset surviving a reload (Refresh)
//   19. lane ordering: priority first, then newest card number
//   20. a project whose lanes are empty, plus the narrow and short-window
//       fallbacks where the page scrolls again
//   21. epic ordering: active epics most-recently-active first, a
//       `Completed · N` separator, then completed epics; the epic <select>s
//       list completed epics in a "Completed" optgroup
//   22. an epic's plan: the `plan` badge on its epics-pane row, its detail's
//       Plan section (link + Markdown body + view toggle) for a project-scoped
//       and a cross-project epic, an unplanned epic showing no Plan section, an
//       empty plan file showing "—" and a deleted one "(file not found)", both
//       without a toggle
//   23. epic rollup pills: each pill shows its lane label and its count, zero included (dimmed)
//   24. phone (390×844): no horizontal scroll, sticky lane header, dialogs fit,
//       the new-card form files a card
//   25. keyboard: tab order, visible focus, Enter/Space open a card, the focus
//       trap, Esc returning focus to the tile, a keyboard move
//   26. states: loading skeletons, the init failure + Retry, a card read refusal
//       in the dialog, a project with no epics, a refused move
//   27. console hygiene: nothing but the two standalone host-URL 404s, on
//       every page above
// Run: node harness/playwright/snap-gui.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { withPage, waitForServer } from '../../../code-playwright/browser.mjs';
import { bootKanban } from './boot-kanban.mjs';
import {
  sel, waitBoard, selectProject, refresh, waitDialog, waitDialogLoaded, closeDialog, waitDialogClosed,
  openCard, openEpic, statusText, consoleGuard,
} from './kanban-ui.mjs';
import { plansDir, boardPlansDir } from '../../src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PROJECT = 'demo';
const PROJECT2 = 'web'; // second project, for the cross-project epic
const PROJECT3 = 'ordering'; // own project for step 21, so no other step's epics shift
const PROJECT4 = 'rollup'; // own project for step 23, so no other step's counts shift
const PROJECT5 = 'bare'; // own project for step 26: no cards, no epics
const DESKTOP = { width: 1440, height: 900 };

/** Switches the emulated OS theme and waits until the page has followed it, transitions finished. */
async function setScheme(page, colorScheme) {
  await page.emulateMedia({ colorScheme });
  await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark
    && document.getAnimations().every((a) => a.playState !== 'running'), colorScheme === 'dark');
}

const shot = (page, name, fullPage = false) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });

// Step 7's card plan: every construct the renderer maps, plus hostile content that
// must stay inert (a javascript: link, an <img onerror>, a remote image beacon and a
// <script> in a fence), long enough to overflow the scroll box. Its one live link
// points at the harness's own server, so clicking it needs no network.
const richPlan = (base) => [
  '---', 'title: Build the search index', 'status: approved', '---', '',
  '# Plan — build the `search` index', '',
  '1. Tokenize documents.', '2. Build the inverted index.', '3. Wire the query path.', '',
  '- Storage', '  - postings on disk', '  - ~~in-memory only~~ dropped', '',
  '- [x] Spike the tokenizer', '- [ ] Benchmark BM25', '',
  '| Stage | Cost | Notes |', '|:--|--:|:-:|', '| tokenize | 2 ms | split<br>stem |', '| index | 40 ms | **hot** path |', '',
  '```html', '<script>window.__pwned = 1</script>', '```', '',
  '> Keep the index rebuildable from the docs.', '',
  `See [the board](${base}/) and [x](javascript:window.__pwned=1).`, '',
  '<img src=x onerror="window.__pwned=1">', '',
  `![b](${base}/beacon.png)`, '',
  '## Notes', '',
  ...Array.from({ length: 16 }, (_, i) => `- Note ${i + 1}: keep _each_ step reversible.`),
  '',
].join('\n');

// Seed a project through the real API (goes through board.js — the single
// writer). In standalone mode (no CONDUCTOR_URL) the project list is the set of
// top-level dirs under PROJECTS_ROOT, so create one so `demo` is selectable.
async function seed(base, projectsRoot) {
  await fs.mkdir(path.join(projectsRoot, PROJECT), { recursive: true });
  await fs.mkdir(path.join(projectsRoot, PROJECT2), { recursive: true });
  const api = (p, opts = {}) => fetch(base + p, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then((r) => r.json());

  // Every seed step must succeed. A silently-refused step (illegal transition,
  // a dropped field) leaves an empty lane and a passing-looking scene, so fail
  // loudly on any {ok:false}.
  const call = async (p, opts, label) => {
    const b = await api(p, opts);
    if (!b || b.ok === false) {
      throw new Error(`seed step "${label}" refused: ${JSON.stringify(b)}`);
    }
    return b;
  };

  await call(`/api/board/${PROJECT}/epics`, { method: 'POST', body: { slug: 'auth', title: 'Auth flow', goal: 'Sign-in + sessions' } }, 'epic auth');
  await call(`/api/board/${PROJECT}/epics`, { method: 'POST', body: { slug: 'search', title: 'Search', goal: 'Full-text search' } }, 'epic search');

  // One card per level (HIGH/CRITICAL/LOW/MEDIUM), plus d, which OMITS it and is
  // therefore unset. d and e are the load-bearing pair: e is a judged MEDIUM and
  // d has never been judged, and a person must tell them apart without opening
  // either. They sit in the same lane so the screenshot shows them side by side.
  const a = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Design login screen', goal: 'Email + password form', acceptance: ['Matches design spec', 'Accessible labels'], epic: 'auth', priority: 'HIGH' } }, 'file a');
  const b = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Hash passwords with argon2', goal: 'No plaintext at rest', epic: 'auth', priority: 'CRITICAL' } }, 'file b');
  const c = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Build search index', goal: 'Inverted index over docs', epic: 'search', priority: 'LOW' } }, 'file c');
  const d = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Triage: spike caching layer', goal: 'Decide redis vs in-memory' } }, 'file d');
  const e = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Rotate the signing key', goal: 'Quarterly rotation', priority: 'MEDIUM' } }, 'file e');

  // Spread cards across lanes via LEGAL transitions. b reaches in-progress
  // through triage→todo→in-progress, so it carries an owner badge (owner is set
  // only on entering in-progress). a→todo, c→backlog, d stays in triage.
  await call(`/api/board/${PROJECT}/cards/${a.id}/move`, { method: 'POST', body: { to: 'todo' } }, 'move a → todo');
  await call(`/api/board/${PROJECT}/cards/${b.id}/move`, { method: 'POST', body: { to: 'todo' } }, 'move b → todo');
  await call(`/api/board/${PROJECT}/cards/${b.id}/move`, { method: 'POST', body: { to: 'in-progress' } }, 'move b → in-progress');
  await call(`/api/board/${PROJECT}/cards/${c.id}/move`, { method: 'POST', body: { to: 'backlog' } }, 'move c → backlog');

  // Cross-project epic spanning demo + web, with a card under it in EACH project.
  await call('/api/epics', { method: 'POST', body: { slug: 'platform', title: 'Platform', goal: 'Shared infra across services', projects: [PROJECT, PROJECT2] } }, 'cross epic platform');
  await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Shared logging', goal: 'One logger', epic: 'platform' } }, 'file demo platform card');
  await call(`/api/board/${PROJECT2}/cards`, { method: 'POST', body: { title: 'Config service', goal: 'Central config', epic: 'platform' } }, 'file web platform card');

  // A plan link on exactly ONE card (c, which stays put in backlog): the other
  // cards are the witness that the badge and the "Has plan" filter discriminate.
  // The plan FILE must exist before update_card accepts the link.
  const planFile = path.join(plansDir(PROJECT), `${c.id}.md`);
  await fs.mkdir(path.dirname(planFile), { recursive: true });
  await fs.writeFile(planFile, richPlan(base));
  await call(`/api/board/${PROJECT}/cards/${c.id}`, { method: 'PATCH', body: { plan: `${c.id}.md` } }, 'plan link on c');

  // Bulk-fill `done` so the lane genuinely overflows a 900px-tall viewport. They
  // all share ONE priority level (unset): within the lane the order is then the
  // id tiebreak and nothing else, which is what step 19 reads.
  const bulk = [];
  for (let i = 1; i <= 14; i++) {
    const n = String(i).padStart(2, '0');
    const t = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: `Done chore ${n}`, goal: `Chore ${n}` } }, `file done chore ${n}`);
    for (const to of ['todo', 'in-progress', 'done']) {
      await call(`/api/board/${PROJECT}/cards/${t.id}/move`, { method: 'POST', body: { to } }, `chore ${n} → ${to}`);
    }
    bulk.push(t);
  }

  return { a, b, c, d, e, bulk };
}

const priorityBadge = (id) => `${sel.tile(id)} ${sel.badge('priority')}`;

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const srv = await bootKanban({ sandbox: { dirs: { PROJECTS_ROOT: 'root' } }, silent: true });
  try {
    await waitForServer(srv.url);
    const projectsRoot = srv.sandbox.dirs.PROJECTS_ROOT;
    // paths.js reads PROJECTS_ROOT at call time; point THIS process at the same
    // sandbox the server got, so plansDir() resolves the child's board dirs.
    process.env.PROJECTS_ROOT = projectsRoot;
    const seeded = await seed(srv.url, projectsRoot);
    const post = async (p, body, method = 'POST') => {
      const r = await fetch(srv.url + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
      if (!r || r.ok === false) throw new Error(`seed ${p} refused: ${JSON.stringify(r)}`);
      await new Promise((res) => setTimeout(res, 5));
      return r;
    };

    await withPage(async (page, { context }) => {
      const guard = consoleGuard(context);
      // 1. Board. Two projects exist and the auto-select order is not guaranteed
      //    by the filesystem scan, so select demo explicitly.
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await selectProject(page, PROJECT);
      await page.waitForSelector(sel.tiles, { timeout: 10_000 });
      await page.waitForSelector(sel.epicRows, { timeout: 10_000 });
      await page.waitForSelector(`${sel.epicRows} ${sel.badge('cross')}`, { timeout: 10_000 });
      assert.deepEqual(
        await page.locator('[data-lane]').evaluateAll((ns) => ns.map((n) => n.dataset.lane)),
        ['triage', 'backlog', 'todo', 'in-progress', 'done'],
      );
      await shot(page, 'gui-1-board', true);
      console.log('snapped board');

      // 1b. Cross-project epic detail: member projects + cards from both projects.
      await openEpic(page, 'platform');
      await page.locator(sel.section('Projects')).waitFor({ timeout: 10_000 });
      assert.match(await page.locator(sel.section('Projects')).textContent(), /demo, web/);
      assert.equal(await page.locator(`${sel.section('Cards')} li`).count(), 2);
      await shot(page, 'gui-1b-cross-epic', true);
      console.log('snapped cross-epic detail');
      await closeDialog(page);

      // 2. Card detail, pinned to a NAMED card (not the first in DOM order, which
      //    depends on the priority sort).
      await openCard(page, seeded.a.id);
      await page.locator(`${sel.section('Logbook')} li`).first().waitFor({ timeout: 10_000 });
      assert.equal(await page.locator(`${sel.dialog} h2`).first().textContent(), 'Design login screen');
      await shot(page, 'gui-2-detail', true);
      console.log('snapped detail');

      // 3. Legal move from the detail: the first legal target, then Move. The
      //    dialog closes and the status line reports the move.
      const target = await page.locator(`${sel.dialog} select[name="to"]`).inputValue();
      assert.ok(target, 'card a has a legal move target');
      await page.locator(sel.dialog).getByRole('button', { name: 'Move' }).click();
      await waitDialogClosed(page);
      await page.waitForFunction(([id, to]) => document.querySelector(`[data-lane="${to}"] [data-card-id="${id}"]`), [seeded.a.id, target], { timeout: 10_000 });
      assert.match(await statusText(page), new RegExp(`^Moved todo → ${target}\\.$`));
      await shot(page, 'gui-3-after-move', true);
      console.log(`snapped after-move (moved to ${target})`);

      // 4. Land b with an explicit commit — the sandboxed project isn't a git
      //    repo, so auto-capture would resolve to null.
      await post(`/api/board/${PROJECT}/cards/${seeded.b.id}/move`, { to: 'done', commit: 'abc1234def5678' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitBoard(page);
      await openCard(page, seeded.b.id);
      assert.match(await page.locator(sel.section('Commit')).textContent(), /abc1234def5678/);
      await shot(page, 'gui-4-detail-done-commit', true);
      console.log('snapped done detail with commit');
      await closeDialog(page);

      // 5. Project-selection persistence: pick a project that differs from the
      //    default fallback (projects[0]), reload, and assert it survives with no
      //    re-pick — the localStorage restore path, not the default.
      const projRes = await fetch(`${srv.url}/api/projects`).then((r) => r.json());
      const defaultProj = projRes.projects[0];
      const persistProj = projRes.projects.find((p) => p !== defaultProj);
      if (!persistProj) throw new Error('need ≥2 projects to discriminate the restore path');
      await selectProject(page, persistProj);
      await page.waitForSelector(sel.tiles, { timeout: 10_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction((v) => document.querySelector('#project-select')?.value === v, persistProj, { timeout: 10_000 });
      await waitBoard(page);
      await page.waitForSelector(sel.tiles, { timeout: 10_000 });
      await shot(page, 'gui-5-persisted-selection', true);
      console.log(`snapped persisted-selection after reload (restored non-default ${persistProj})`);

      // 6. Plan badge: back on demo, exactly one card carries a plan link.
      await selectProject(page, PROJECT);
      assert.equal(await page.locator(`${sel.tiles} ${sel.badge('plan')}`).count(), 1, 'exactly one plan badge');
      assert.equal(await page.locator(`${sel.tile(seeded.c.id)} ${sel.badge('plan')}`).getAttribute('title'), `board:${seeded.c.id}.md`);
      await shot(page, 'gui-6-plan-badge', true);
      console.log('snapped plan badge');

      // 7. Plan detail: the link AND the file's body (via ?includePlan=1), rendered
      //    as Markdown by default, hostile content inert, Raw a toggle away, and the
      //    view not remembered across opens.
      const requests = [];
      context.on('request', (r) => requests.push(r.url()));
      await openCard(page, seeded.c.id);
      const plan = page.locator(sel.section('Plan'));
      const viewButton = (name) => plan.getByRole('group', { name: 'Plan view' }).getByRole('button', { name, exact: true });
      const md = plan.locator('[data-plan-body="markdown"]');
      await md.locator('ol li', { hasText: 'Build the inverted index' }).waitFor({ timeout: 10_000 });
      assert.equal(await viewButton('Markdown').getAttribute('aria-pressed'), 'true');
      assert.equal(await viewButton('Raw').getAttribute('aria-pressed'), 'false');
      // The frontmatter is one verbatim block ahead of the body, not rules around a run-on paragraph.
      assert.equal(await md.locator(':scope > pre').first().textContent(), '---\ntitle: Build the search index\nstatus: approved\n---');
      assert.equal(await md.locator(':scope > hr').count(), 0);
      assert.match(await md.locator('h4').first().textContent(), /^Plan — build the search index$/);
      assert.equal(await md.locator('h4 code').textContent(), 'search');
      assert.equal(await md.locator('table').count(), 1);
      assert.deepEqual(await md.locator('th').evaluateAll((ns) => ns.map((n) => getComputedStyle(n).textAlign)), ['left', 'right', 'center']);
      assert.equal(await md.locator('td br').count(), 1, 'the <br> in a cell is a line break');
      assert.equal(await md.locator('[role="checkbox"][disabled]').count(), 2);
      assert.equal(await md.getByRole('checkbox', { name: 'Spike the tokenizer' }).getAttribute('aria-checked'), 'true');
      assert.equal(await md.locator('pre code').count(), 2, 'the frontmatter block and the fence');
      assert.equal(await md.locator('pre code').nth(1).textContent(), '<script>window.__pwned = 1</script>');
      assert.equal(await md.locator('blockquote').count(), 1);
      assert.equal(await md.locator('del').textContent(), 'in-memory only');
      // Hostile content stays text: no element, no script run, no request.
      assert.equal(await plan.locator('img, script, iframe, style').count(), 0, 'no img/script/iframe/style in the plan');
      assert.equal(await page.evaluate(() => window.__pwned), undefined);
      const text = await md.textContent();
      for (const literal of ['[x](javascript:window.__pwned=1)', '<img src=x onerror="window.__pwned=1">', `![b](${srv.url}/beacon.png)`]) {
        assert.ok(text.includes(literal), `shows as text: ${literal}`);
      }
      const anchors = await plan.locator('a').evaluateAll((ns) => ns.map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })));
      assert.deepEqual(anchors, [{ href: `${srv.url}/`, target: '_blank', rel: 'noopener noreferrer' }]);
      // A bounded scroll box (max-h-96 = 384px) that the plan overflows.
      const box = async (view) => plan.locator(`[data-plan-body="${view}"]`).evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
      const mdBox = await box('markdown');
      assert.ok(mdBox.client <= 384 && mdBox.scroll > mdBox.client, `markdown box ${JSON.stringify(mdBox)}`);
      // Every block at its content height: a fence or table squeezed by its scroll container is clipped.
      const squeezed = await md.locator('pre, div.overflow-x-auto').evaluateAll((ns) => ns.filter((n) => n.scrollHeight > n.clientHeight + 1).length);
      assert.equal(squeezed, 0, 'a fence or table is clipped to less than its content height');
      await plan.scrollIntoViewIfNeeded();
      await shot(page, 'gui-7-plan-detail');
      await md.evaluate((el) => { el.scrollTop = 330; });
      await shot(page, 'gui-7c-plan-markdown-scrolled');
      await md.evaluate((el) => { el.scrollTop = 0; });
      await setScheme(page, 'dark');
      await shot(page, 'gui-7-plan-detail-dark');
      await setScheme(page, 'light');
      // The live link opens a new top-level context; the board page stays put.
      const before7 = page.url();
      const [popup] = await Promise.all([context.waitForEvent('page'), plan.getByRole('link', { name: 'the board' }).click()]);
      await popup.waitForLoadState('domcontentloaded');
      assert.equal(page.url(), before7);
      assert.equal(await popup.evaluate(() => window.opener), null);
      await popup.close();
      // Raw: today's <pre>, byte for byte.
      await viewButton('Raw').click();
      assert.equal(await viewButton('Raw').getAttribute('aria-pressed'), 'true');
      assert.equal(await viewButton('Markdown').getAttribute('aria-pressed'), 'false');
      const raw = plan.locator('[data-plan-body="raw"]');
      assert.equal(await raw.evaluate((el) => el.tagName), 'PRE');
      const rawText = await raw.textContent();
      assert.ok(rawText.startsWith('---\ntitle: Build the search index\n') && rawText.includes('\n# Plan — build the `search` index\n')
        && rawText.includes('<img src=x onerror='), 'raw shows the source');
      assert.equal(await plan.locator('[data-plan-body="markdown"]').count(), 0);
      const rawBox = await box('raw');
      assert.ok(rawBox.client <= 384 && rawBox.scroll > rawBox.client, `raw box ${JSON.stringify(rawBox)}`);
      await shot(page, 'gui-7b-plan-raw');
      await setScheme(page, 'dark');
      await shot(page, 'gui-7b-plan-raw-dark');
      await setScheme(page, 'light');
      // Not remembered: the next open starts in Markdown again.
      await closeDialog(page);
      await openCard(page, seeded.c.id);
      await md.waitFor({ timeout: 10_000 });
      assert.equal(await viewButton('Markdown').getAttribute('aria-pressed'), 'true');
      // The log is live: it holds this card's plan-body read, so an empty filter below means no beacon,
      // not a listener attached too late.
      assert.ok(requests.some((u) => u.includes(`/cards/${seeded.c.id}?includePlan=1`)), `request log is live (${requests.length} requests)`);
      assert.deepEqual(requests.filter((u) => /beacon/.test(u)), [], 'the image beacon was never requested');
      assert.equal(await page.evaluate(() => window.__pwned), undefined);
      console.log('snapped plan detail (markdown light/dark, raw light/dark, inert hostile content, popup link, view reset)');
      await closeDialog(page);

      // 8. Has-plan filter drops every card WITHOUT a plan, and lanes left empty
      //    say so.
      const before = await page.locator(sel.tiles).count();
      await page.getByRole('checkbox', { name: 'Has plan' }).check();
      await page.waitForFunction(() => document.querySelectorAll('[data-card-id]').length === 1, { timeout: 10_000 });
      if (before <= 1) throw new Error(`filter proves nothing: only ${before} card(s) before filtering`);
      assert.equal(await page.locator(`${sel.lane('todo')} [data-empty]`).textContent(), 'No planned cards');
      await shot(page, 'gui-8-plan-filter', true);
      console.log(`snapped has-plan filter (${before} cards -> 1)`);
      await page.getByRole('checkbox', { name: 'Has plan' }).uncheck();
      await page.waitForFunction((n) => document.querySelectorAll('[data-card-id]').length === n, before, { timeout: 10_000 });

      // 9. Priority badges: EVERY judged level badges, so a bare card means
      //    nobody has judged it. e (judged MEDIUM) vs d (unset) is the pair.
      assert.equal(await page.locator(`${sel.tiles} ${sel.badge('priority')}`).count(), 4, 'one badge per judged level');
      assert.equal(await page.locator(priorityBadge(seeded.e.id)).textContent(), 'medium');
      assert.equal(await page.locator(priorityBadge(seeded.d.id)).count(), 0, 'an unjudged card renders bare');
      await shot(page, 'gui-9-priority-badges', true);
      console.log('snapped priority badges (4 judged badged, unset bare)');

      // 10. The bare card's detail says "unset", not blank.
      await openCard(page, seeded.d.id);
      assert.equal(await page.locator(`${sel.section('Priority')} p`).textContent(), 'unset');
      await shot(page, 'gui-10-unset-detail', true);
      console.log('snapped unset card detail (states "unset", not blank)');

      // 11. Edit: a select over the levels, led by the unset option, which is
      //     selected on an unjudged card.
      await page.locator(sel.dialog).getByRole('button', { name: 'Edit' }).click();
      const prio = page.locator(`${sel.dialog} select[name="priority"]`);
      await prio.waitFor({ timeout: 10_000 });
      assert.equal((await prio.locator('option').allTextContents()).join(','), '— unset —,CRITICAL,HIGH,MEDIUM,LOW');
      assert.equal(await prio.inputValue(), '', 'an unjudged card preselects the unset option');
      await shot(page, 'gui-11-edit-priority-select', true);
      console.log('snapped edit form priority select (unset preselected)');

      // 12. Judge it through the select; the badge appears on the board.
      await prio.selectOption('CRITICAL');
      await page.locator(sel.dialog).getByRole('button', { name: 'Save' }).click();
      await waitDialogClosed(page);
      await page.waitForFunction((s) => document.querySelector(s)?.textContent === 'critical', priorityBadge(seeded.d.id), { timeout: 10_000 });
      assert.equal(await statusText(page), 'Saved.');
      await shot(page, 'gui-12-priority-edited', true);
      console.log('snapped board after judging an unset card CRITICAL through the select');

      // 12b. And the reverse: clearing a judged card to unset removes its badge.
      await openCard(page, seeded.e.id);
      await page.locator(sel.dialog).getByRole('button', { name: 'Edit' }).click();
      await prio.waitFor({ timeout: 10_000 });
      assert.equal(await prio.inputValue(), 'MEDIUM', 'a judged card preselects its level');
      await prio.selectOption('');
      await page.locator(sel.dialog).getByRole('button', { name: 'Save' }).click();
      await waitDialogClosed(page);
      await page.waitForFunction((s) => !document.querySelector(s), priorityBadge(seeded.e.id), { timeout: 10_000 });
      await shot(page, 'gui-12b-priority-cleared', true);
      console.log('snapped board after clearing MEDIUM -> unset (badge removed)');

      // 13. The new-card form asks for a priority but does not pre-answer it.
      await page.getByRole('button', { name: 'New card' }).click();
      await waitDialog(page);
      assert.equal(await page.locator(`${sel.dialog} select[name="priority"]`).inputValue(), '');
      await shot(page, 'gui-13-new-card-priority', true);
      console.log('snapped new-card form priority select (opens unset)');
      await closeDialog(page);

      // 14. Acceptance is editable. Pre-tick a's FIRST criterion over the API
      //     (no per-item toggle in the GUI), then the textarea is prefilled one
      //     criterion per line.
      await post(`/api/board/${PROJECT}/cards/${seeded.a.id}`, { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } }, 'PATCH');
      await refresh(page);
      await openCard(page, seeded.a.id);
      await page.locator(sel.dialog).getByRole('button', { name: 'Edit' }).click();
      const acceptance = page.locator(`${sel.dialog} textarea[name="acceptance"]`);
      await acceptance.waitFor({ timeout: 10_000 });
      assert.equal(await acceptance.inputValue(), 'Matches design spec\nAccessible labels');
      await shot(page, 'gui-14-edit-acceptance-prefilled', true);
      console.log('snapped edit form with acceptance textarea prefilled');

      // 15. Rename the SECOND (unticked) line, add a third, Save. The first
      //     line's tick survives the {replace} round trip.
      await acceptance.fill('Matches design spec\nAccessible labels, verified\nKeyboard navigable');
      await page.locator(sel.dialog).getByRole('button', { name: 'Save' }).click();
      await waitDialogClosed(page);
      await openCard(page, seeded.a.id);
      const items = await page.locator(`${sel.section('Acceptance')} li`).allTextContents();
      assert.equal(items.length, 3, items.join(' | '));
      assert.ok(items.some((t) => t.includes('Accessible labels, verified')));
      assert.ok(items.some((t) => t.includes('Keyboard navigable')));
      assert.equal(await page.locator(`${sel.section('Acceptance')} [role="checkbox"][data-state="checked"]`).count(), 1, 'exactly one tick survives');
      await shot(page, 'gui-15-acceptance-edited', true);
      console.log('snapped read view after acceptance edit (renamed + added criterion, tick survived)');
      await closeDialog(page);

      // 16. Per-lane scrolling. `done` holds 15 cards, far more than a 900px
      //     viewport fits: the PAGE must not stretch, and the LANE must scroll.
      const geom = await page.evaluate(() => {
        const main = document.querySelector('main');
        const body = document.querySelector('[data-lane="done"] [data-lane-body]');
        return { mainScroll: main.scrollHeight, mainClient: main.clientHeight, laneScroll: body.scrollHeight, laneClient: body.clientHeight };
      });
      assert.ok(geom.mainScroll <= geom.mainClient + 1, `the board must fit the viewport, but main scrolls: ${geom.mainScroll} > ${geom.mainClient}`);
      assert.ok(geom.laneScroll > geom.laneClient, `the done lane must overflow its own box, but ${geom.laneScroll} <= ${geom.laneClient}`);
      await shot(page, 'gui-16-lane-scroll');
      console.log(`snapped per-lane scroll (page fits ${geom.mainScroll}<=${geom.mainClient}, done lane ${geom.laneScroll}>${geom.laneClient})`);

      // 17. The lane HEADER stays put while its body scrolls, and the other
      //     lanes don't move with it.
      const headTop = () => page.locator(sel.laneHead('done')).evaluate((h) => h.getBoundingClientRect().top);
      const headBefore = await headTop();
      await page.locator(sel.laneBody('done')).evaluate((b) => { b.scrollTop = b.scrollHeight; });
      assert.equal(await headTop(), headBefore, 'the done lane header moved when its body scrolled');
      const otherOffsets = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-lane]')]
        .filter((c) => c.dataset.lane !== 'done')
        .map((c) => [c.dataset.lane, c.querySelector('[data-lane-body]').scrollTop])));
      for (const [st, top] of Object.entries(otherOffsets)) assert.equal(top, 0, `scrolling done also scrolled ${st}`);
      await shot(page, 'gui-17-lane-header-pinned');
      console.log('snapped done lane scrolled to the bottom (header pinned, other lanes at 0)');

      // 18. The offset survives a reload: lanes are keyed by state and stay
      //     mounted, so Refresh must not yank a deep lane back to the top.
      await page.locator(sel.laneBody('done')).evaluate((b) => { b.scrollTop = 200; });
      await refresh(page);
      assert.match(await statusText(page), /^Loaded \d+ card\(s\) across \d+ epic\(s\)\.$/);
      assert.equal(await page.locator(`${sel.lane('done')} ${sel.tiles}`).count(), 15);
      const afterRefresh = await page.locator(sel.laneBody('done')).evaluate((b) => b.scrollTop);
      assert.ok(Math.abs(afterRefresh - 200) <= 1, `lane scroll lost across the reload: expected ~200, saw ${afterRefresh}`);
      await shot(page, 'gui-18-lane-scroll-survives-refresh');
      console.log(`snapped done lane still scrolled (${afterRefresh}px) after Refresh`);

      // 19. Lane ORDERING — priority first, then card number DESCENDING. `done`
      //     holds the judged CRITICAL b (the OLDEST id) plus 14 unset chores.
      const doneCards = await page.locator(`${sel.lane('done')} ${sel.tiles}`).evaluateAll((els) => els.map((c) => ({
        id: c.dataset.cardId,
        prio: c.querySelector('[data-badge="priority"]')?.textContent ?? null,
      })));
      assert.equal(doneCards.length, 15);
      assert.equal(doneCards[0].prio, 'critical', `the judged CRITICAL must lead its lane, saw ${JSON.stringify(doneCards[0])}`);
      assert.equal(doneCards[0].id, seeded.b.id);
      const num = (id) => Number(id.split('-')[1]);
      const chores = doneCards.slice(1);
      for (const c of chores) assert.equal(c.prio, null);
      for (let i = 1; i < chores.length; i++) assert.ok(num(chores[i - 1].id) > num(chores[i].id), `${chores[i - 1].id} then ${chores[i].id}`);
      await shot(page, 'gui-19-lane-order');
      console.log(`snapped lane ordering (${doneCards[0].id} leads, then ${chores[0].id}..${chores.at(-1).id} descending)`);

      // 20a. Empty lanes: `web` holds a single card, so four lanes are empty;
      //      each says so and the board still fits.
      await selectProject(page, PROJECT2);
      await page.waitForFunction(() => document.querySelectorAll('[data-empty]').length === 4, { timeout: 10_000 });
      const emptyGeom = await page.evaluate(() => { const m = document.querySelector('main'); return { scroll: m.scrollHeight, client: m.clientHeight }; });
      assert.ok(emptyGeom.scroll <= emptyGeom.client + 1, `an all-but-one-empty board must still fit: ${emptyGeom.scroll} > ${emptyGeom.client}`);
      await shot(page, 'gui-20a-empty-lanes');
      console.log('snapped a project with four empty lanes (placeholders render, board fits)');
      guard.assertClean('desktop golden path');
    }, { headless: true, viewport: DESKTOP });

    // 20b. Narrow window (below `lg`): two lanes per row, content height, the
    //      PAGE scrolls again — and nothing scrolls horizontally.
    await withPage(async (page, { context }) => {
      const guard = consoleGuard(context);
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await selectProject(page, PROJECT);
      const narrow = await page.evaluate(() => {
        const main = document.querySelector('main');
        const doc = document.documentElement;
        const lanes = [...document.querySelectorAll('[data-lane]')].map((l) => l.getBoundingClientRect().left);
        return { mainScroll: main.scrollHeight, mainClient: main.clientHeight, docScrollW: doc.scrollWidth, docClientW: doc.clientWidth, columns: new Set(lanes.map(Math.round)).size };
      });
      assert.equal(narrow.columns, 2, 'two lanes per row below lg');
      assert.ok(narrow.mainScroll > narrow.mainClient, `below lg the page must scroll again, but main fits: ${narrow.mainScroll} <= ${narrow.mainClient}`);
      assert.ok(narrow.docScrollW <= narrow.docClientW + 1, `no horizontal page scroll allowed, saw ${narrow.docScrollW} > ${narrow.docClientW}`);
      await shot(page, 'gui-20b-narrow-page-scroll');
      console.log(`snapped narrow window (page scrolls ${narrow.mainScroll}>${narrow.mainClient}, no horizontal scroll)`);
      guard.assertClean('narrow window');
    }, { headless: true, viewport: { width: 700, height: 900 } });

    // 20c. Short window: still five columns, but shorter than the board's
    //      floor, so `main` scrolls the page and every lane stays reachable.
    await withPage(async (page, { context }) => {
      const guard = consoleGuard(context);
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await selectProject(page, PROJECT);
      const short = await page.evaluate(() => {
        const main = document.querySelector('main');
        const doc = document.documentElement;
        main.scrollTop = main.scrollHeight;
        return {
          mainScroll: main.scrollHeight, mainClient: main.clientHeight, mainTop: main.scrollTop, mainBottom: main.getBoundingClientRect().bottom,
          docScrollW: doc.scrollWidth, docClientW: doc.clientWidth,
          lanes: [...document.querySelectorAll('[data-lane]')].map((c) => ({ state: c.dataset.lane, bottom: Math.round(c.getBoundingClientRect().bottom) })),
        };
      });
      assert.ok(short.mainScroll > short.mainClient, `a window shorter than the board floor must scroll the page: ${short.mainScroll} <= ${short.mainClient}`);
      assert.ok(short.mainTop > 0, 'the page-scroll fallback did not actually scroll');
      assert.ok(short.docScrollW <= short.docClientW + 1, `no horizontal page scroll allowed, saw ${short.docScrollW} > ${short.docClientW}`);
      for (const lane of short.lanes) assert.ok(lane.bottom <= short.mainBottom + 1, `lane ${lane.state} is still cut off after scrolling to the bottom (bottom ${lane.bottom})`);
      await shot(page, 'gui-20c-short-page-scroll');
      console.log(`snapped short window (page scrolls to ${short.mainTop}, every lane reachable)`);
      guard.assertClean('short window');
    }, { headless: true, viewport: { width: 1440, height: 420 } });

    // 21. Epic ordering, seeded through the real routes (wall-clock stamps, so a
    //     few ms between steps keeps each one strictly newer). Creation order is
    //     empty → alpha-old → beta-new → shipped; then shipped's only card walks
    //     to done (completed), and LAST alpha-old's card moves, which must lift
    //     alpha-old above beta-new despite the older epic record.
    await fs.mkdir(path.join(projectsRoot, PROJECT3), { recursive: true });
    const B = `/api/board/${PROJECT3}`;
    await post(`${B}/epics`, { slug: 'empty', title: 'Empty epic' });
    await post(`${B}/epics`, { slug: 'alpha-old', title: 'Older epic, fresh card move' });
    const oldCard = await post(`${B}/cards`, { title: 'Old epic card', epic: 'alpha-old' });
    await post(`${B}/epics`, { slug: 'beta-new', title: 'Newer epic record' });
    await post(`${B}/cards`, { title: 'New epic card', epic: 'beta-new' });
    await post(`${B}/epics`, { slug: 'shipped', title: 'All cards done' });
    const shipCard = await post(`${B}/cards`, { title: 'Shipped card', epic: 'shipped' });
    for (const to of ['todo', 'in-progress', 'done']) await post(`${B}/cards/${shipCard.id}/move`, { to });
    await post(`${B}/cards/${oldCard.id}/move`, { to: 'todo' });

    await withPage(async (page, { context }) => {
      const guard = consoleGuard(context);
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await selectProject(page, PROJECT3);
      await page.waitForSelector(`${sel.epicsPane} [role="separator"]`, { timeout: 10_000 });
      const pane = await page.locator(`${sel.epicsPane} :is([data-epic-slug], [role="separator"])`).evaluateAll((ns) => ns.map((n) => (
        n.getAttribute('role') === 'separator' ? `SEP:${n.textContent}` : n.dataset.epicSlug)));
      assert.deepEqual(pane, ['alpha-old', 'beta-new', 'empty', 'SEP:Completed · 1', 'shipped'], `epics pane order: ${pane.join(', ')}`);
      await page.locator(sel.epicsPane).screenshot({ path: path.join(SHOTS, 'gui-21a-epic-order.png') });
      await shot(page, 'gui-21b-epic-order-board');
      // The pane is capped at 25vh, so the completed group sits below the fold.
      await page.locator(sel.epicsPane).evaluate((p) => { p.scrollTop = p.scrollHeight; });
      await page.locator(sel.epicsPane).screenshot({ path: path.join(SHOTS, 'gui-21c-epic-order-completed.png') });

      // New-card <select>: an open native dropdown can't be screenshotted, so
      // read its structure — top-level options, then the Completed optgroup.
      const selectShape = (s) => page.locator(s).evaluate((el) => [...el.children].map((n) => (
        n.tagName === 'OPTGROUP' ? `[${n.label}: ${[...n.children].map((o) => o.value).join(', ')}]` : n.value || '(none)')));
      await page.getByRole('button', { name: 'New card' }).click();
      await waitDialog(page);
      const newShape = await selectShape(`${sel.dialog} select[name="epic"]`);
      assert.deepEqual(newShape, ['(none)', 'alpha-old', 'beta-new', 'empty', '[Completed: shipped]'], `new-card epic select: ${newShape.join(', ')}`);
      await closeDialog(page);

      // Edit-card <select> on the shipped card keeps its (completed) epic selected.
      await openCard(page, shipCard.id);
      await page.locator(sel.dialog).getByRole('button', { name: 'Edit' }).click();
      const editEpic = await page.locator(`${sel.dialog} select[name="epic"]`).inputValue();
      assert.equal(editEpic, 'shipped', 'edit form must keep a completed epic selected');
      console.log(`snapped epic ordering (${pane.join(' | ')}); selects: ${newShape.join(', ')}; edit keeps "${editEpic}"`);
      guard.assertClean('epic ordering');
    }, { headless: true, viewport: DESKTOP });

    // 22. Epic plan. Seeded only now so steps 6–8's card-only plan counts are
    //     untouched. The HTTP epic routes take no `plan`, so attach it through
    //     the MCP bridge's create_epic (an upsert that keeps title/goal).
    const epicPlan = path.join(plansDir(PROJECT), 'epic-search.md');
    await fs.writeFile(epicPlan, '# Plan — search epic\n\n- Rank results by BM25.\n- Cache hot queries.\n');
    const createEpic = async (args) => {
      const mcp = await fetch(`${srv.url}/api/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'create_epic', arguments: args }),
      }).then((x) => x.json());
      if (mcp?.result?.ok !== true) throw new Error(`step 22 seed create_epic ${args.slug} refused: ${JSON.stringify(mcp)}`);
    };
    await createEpic({ project: PROJECT, slug: 'search', title: 'Search', plan: 'epic-search.md' });
    const crossPlan = path.join(boardPlansDir(), 'epic-platform.md');
    await fs.mkdir(path.dirname(crossPlan), { recursive: true });
    await fs.writeFile(crossPlan, '# Plan — platform epic\n\n1. One logger, one config service.\n2. One deploy pipeline.\n');
    await createEpic({ projects: [PROJECT, PROJECT2], slug: 'platform', title: 'Platform', plan: 'epic-platform.md' });

    await withPage(async (page, { context }) => {
      const guard = consoleGuard(context);
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await selectProject(page, PROJECT);
      await page.waitForSelector(`${sel.epicRows} ${sel.badge('plan')}`, { timeout: 10_000 });
      assert.equal(await page.locator(`${sel.epicRows} ${sel.badge('plan')}`).count(), 2, 'exactly 2 epic plan badges (search + platform)');
      assert.equal(await page.locator(`${sel.epicRow('search')} ${sel.badge('plan')}`).getAttribute('title'), 'board:epic-search.md');
      assert.equal(await page.locator(`${sel.epicRow('auth')} ${sel.badge('plan')}`).count(), 0, 'auth is unplanned');
      await page.locator(sel.epicsPane).screenshot({ path: path.join(SHOTS, 'gui-22a-epic-plan-badge.png') });

      const planLink = () => page.locator(`${sel.dialog} [data-plan-link]`).textContent();
      const planToggle = () => page.locator(sel.section('Plan')).getByRole('group', { name: 'Plan view' });
      await openEpic(page, 'search');
      await page.locator(`${sel.section('Plan')} [data-plan-body="markdown"] ul li`, { hasText: 'Rank results by BM25' }).waitFor({ timeout: 10_000 });
      assert.equal(await page.locator(`${sel.section('Plan')} [data-plan-body="markdown"] h4`).textContent(), 'Plan — search epic');
      assert.equal(await planToggle().count(), 1);
      assert.equal(await planLink(), 'board:epic-search.md');
      await shot(page, 'gui-22b-epic-plan-detail');
      await closeDialog(page);

      // Cross-project branch: reads through api/epics/:slug.
      await openEpic(page, 'platform');
      await page.locator(`${sel.section('Plan')} [data-plan-body="markdown"] ol li`, { hasText: 'One logger, one config service.' }).waitFor({ timeout: 10_000 });
      assert.equal(await planToggle().count(), 1);
      assert.equal(await planLink(), 'board:epic-platform.md');
      await shot(page, 'gui-22d-cross-epic-plan-detail');
      await closeDialog(page);

      // An empty plan file: the dash placeholder, and no toggle.
      await fs.writeFile(crossPlan, '');
      await openEpic(page, 'platform');
      await page.locator(`${sel.section('Plan')} pre`, { hasText: '—' }).waitFor({ timeout: 10_000 });
      assert.equal(await planToggle().count(), 0, 'an empty plan has no view toggle');
      assert.equal(await page.locator(`${sel.section('Plan')} ${sel.planBody}`).count(), 0);
      await closeDialog(page);

      await openEpic(page, 'auth');
      assert.equal(await page.locator(sel.section('Plan')).count(), 0, 'an unplanned epic shows no Plan section');
      await closeDialog(page);

      await fs.rm(epicPlan);
      await openEpic(page, 'search');
      await page.locator(sel.section('Plan'), { hasText: '(file not found)' }).waitFor({ timeout: 10_000 });
      assert.equal(await planToggle().count(), 0, 'a missing plan has no view toggle');
      assert.equal(await planLink(), 'board:epic-search.md');
      await shot(page, 'gui-22c-epic-plan-missing');
      console.log('snapped epic plan (badge, detail body, unplanned witness, missing file)');
      guard.assertClean('epic plan');
    }, { headless: true, viewport: DESKTOP });

    // 23. Rollup pills. Distinct per-lane counts (1/2/3/4) so a wrong or swapped
    //     number fails, plus an empty `done` lane for the zero rendering.
    await fs.mkdir(path.join(projectsRoot, PROJECT4), { recursive: true });
    const R = `/api/board/${PROJECT4}`;
    await post(`${R}/epics`, { slug: 'counts', title: 'Rollup counts' });
    const walks = [[], ['backlog'], ['backlog'], ['todo'], ['todo'], ['todo'],
      ['todo', 'in-progress'], ['todo', 'in-progress'], ['todo', 'in-progress'], ['todo', 'in-progress']];
    for (const [i, moves] of walks.entries()) {
      const c = await post(`${R}/cards`, { title: `Rollup card ${i + 1}`, epic: 'counts' });
      for (const to of moves) await post(`${R}/cards/${c.id}/move`, { to });
    }

    await withPage(async (page, { context }) => {
      const guard = consoleGuard(context);
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await selectProject(page, PROJECT4);
      const row = sel.epicRow('counts');
      await page.waitForSelector(`${row} ${sel.pills}`, { timeout: 10_000 });
      // Order follows meta.states; labels are ROLLUP_LABEL (frontend/src/lib/board.ts).
      const expected = [['tr: 1', '1', 'false'], ['bk: 2', '2', 'false'], ['td: 3', '3', 'false'], ['ip: 4', '4', 'false'], ['dn: 0', '0', 'true']];
      const readPills = (s) => page.locator(s).evaluateAll((ns) => ns.map((n) => [n.textContent, n.querySelector('b')?.textContent ?? null, n.dataset.zero]));
      assert.deepEqual(await readPills(`${row} ${sel.pills}`), expected);
      await page.locator(sel.epicsPane).screenshot({ path: path.join(SHOTS, 'gui-23a-rollup-counts.png') });

      await openEpic(page, 'counts');
      assert.deepEqual(await readPills(`${sel.dialog} ${sel.pills}`), expected);
      await shot(page, 'gui-23b-rollup-counts-detail');
      console.log('snapped rollup pill counts (pane + epic detail)');
      guard.assertClean('rollup pills');
    }, { headless: true, viewport: DESKTOP });

    // 24. Phone. A card whose goal runs far past one screen, for the dialog's
    //     own scroller.
    const longCard = await post(`/api/board/${PROJECT}/cards`, {
      title: 'A card with a long goal',
      goal: Array.from({ length: 60 }, (_, i) => `Goal line ${i + 1}`).join('\n'),
      acceptance: ['First criterion', 'Second criterion'],
    });
    await withPage(async (page, { context }) => {
      const guard = consoleGuard(context);
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await selectProject(page, PROJECT);
      const lanesX = await page.locator('[data-lane]').evaluateAll((ns) => new Set(ns.map((n) => Math.round(n.getBoundingClientRect().left))).size);
      assert.equal(lanesX, 1, 'one lane per row on a phone');
      const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      assert.ok(await noHScroll(), 'no horizontal page scroll on a phone');
      await shot(page, 'gui-24a-phone-board');

      // Scroll the page into the long `done` lane: its header sticks to the top
      // of the scroller while the lane's cards pass under it.
      const stuck = await page.evaluate(() => {
        const main = document.querySelector('main');
        const lane = document.querySelector('[data-lane="done"]');
        main.scrollTop += lane.getBoundingClientRect().top - main.getBoundingClientRect().top + 300;
        const head = lane.querySelector('[data-lane-head]').getBoundingClientRect().top;
        // A sticky box sticks to its scroller's content edge, inside the padding.
        const edge = main.getBoundingClientRect().top + parseFloat(getComputedStyle(main).paddingTop);
        return { head, edge, laneTop: lane.getBoundingClientRect().top };
      });
      await shot(page, 'gui-24b-phone-sticky-header');
      assert.ok(stuck.laneTop < stuck.edge, 'the lane scrolled past the top');
      assert.ok(Math.abs(stuck.head - stuck.edge) <= 1, `the lane header sticks to the top (${stuck.head} vs ${stuck.edge})`);

      await page.locator('main').evaluate((m) => { m.scrollTop = 0; });
      await openCard(page, longCard.id);
      const vp = page.viewportSize();
      const box = await page.locator(sel.dialog).boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1, `the dialog fits the viewport: ${JSON.stringify(box)}`);
      const inner = await page.locator(sel.dialog).evaluate((d) => ({ scroll: d.scrollHeight, client: d.clientHeight, overflow: getComputedStyle(d).overflowY }));
      assert.equal(inner.overflow, 'auto');
      assert.ok(inner.scroll > inner.client, `a long card scrolls inside its dialog (${inner.scroll} > ${inner.client})`);
      await shot(page, 'gui-24c-phone-detail');
      await page.locator(sel.dialog).getByRole('button', { name: 'Edit' }).click();
      await page.locator(`${sel.dialog} form`).waitFor({ timeout: 10_000 });
      await shot(page, 'gui-24d-phone-edit');
      await closeDialog(page);

      await page.getByRole('button', { name: 'New epic' }).click();
      await waitDialog(page);
      await shot(page, 'gui-24e-phone-new-epic');
      await closeDialog(page);
      await page.getByRole('button', { name: 'Sync' }).click();
      await waitDialog(page);
      await shot(page, 'gui-24f-phone-sync');
      await closeDialog(page);

      await page.getByRole('button', { name: 'New card' }).click();
      await waitDialog(page);
      await page.locator(sel.dialog).getByLabel('Title').fill('Filed from a phone');
      await page.locator(sel.dialog).getByRole('button', { name: 'File into triage' }).click();
      await waitDialogClosed(page);
      await page.locator(`${sel.lane('triage')} ${sel.tiles}`, { hasText: 'Filed from a phone' }).waitFor({ timeout: 10_000 });
      assert.match(await statusText(page), /^Filed \d{4}-\d{4,} into triage\.$/);
      assert.ok(await noHScroll(), 'still no horizontal scroll');
      console.log('snapped phone layout (one lane per row, sticky header, dialogs fit, card filed)');
      guard.assertClean('phone');
    }, { headless: true, viewport: { width: 390, height: 844 } });

    // 25. Keyboard.
    await withPage(async (page, { context }) => {
      const guard = consoleGuard(context);
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await selectProject(page, PROJECT);
      const active = () => page.evaluate(() => {
        const a = document.activeElement;
        return a?.dataset?.cardId || a?.id || a?.getAttribute('aria-label') || a?.textContent?.trim() || a?.tagName;
      });
      await page.evaluate(() => document.activeElement?.blur());
      const order = [];
      for (let i = 0; i < 7; i++) { await page.keyboard.press('Tab'); order.push(await active()); }
      const firstTile = await page.locator(sel.tiles).first().getAttribute('data-card-id');
      assert.deepEqual(order, ['project-select', 'plan-filter', 'New card', 'New epic', 'Sync', 'Refresh', firstTile], `tab order: ${order.join(' → ')}`);
      const ring = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
      assert.notEqual(ring, 'none', 'a focused tile shows a focus ring');
      await shot(page, 'gui-25a-keyboard-focus');

      await page.keyboard.press('Enter');
      await waitDialogLoaded(page);
      assert.ok(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), 'focus moves into the dialog');
      for (let i = 0; i < 15; i++) await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), 'Tab stays trapped in the dialog');
      await page.keyboard.press('Escape');
      await waitDialogClosed(page);
      assert.equal(await active(), firstTile, 'focus returns to the tile that opened the dialog');

      await page.keyboard.press(' ');
      await waitDialogLoaded(page);
      assert.match(await page.locator(`${sel.dialog} [data-slot="dialog-description"]`).textContent(), new RegExp(firstTile));
      await page.keyboard.press('Escape');
      await waitDialogClosed(page);

      // A keyboard move: open d (triage), focus the Move select, pick the second
      // target with the arrow key, Tab to Move, Enter.
      await page.locator(sel.tile(seeded.d.id)).focus();
      await page.keyboard.press('Enter');
      await waitDialogLoaded(page);
      const moveSelect = page.locator(`${sel.dialog} select[name="to"]`);
      await moveSelect.focus();
      const options = await moveSelect.locator('option').evaluateAll((os) => os.map((o) => o.value));
      await page.keyboard.press('ArrowDown');
      const picked = await moveSelect.inputValue();
      assert.equal(picked, options[1], `ArrowDown picks the next target (${options.join(', ')})`);
      await page.keyboard.press('Tab');
      assert.equal(await active(), 'Move');
      await page.keyboard.press('Enter');
      await waitDialogClosed(page);
      await page.waitForSelector(`${sel.lane(picked)} ${sel.tile(seeded.d.id)}`, { timeout: 10_000 });
      assert.equal(await statusText(page), `Moved triage → ${picked}.`);
      console.log(`keyboard: tab order ok, focus ring, Enter/Space open, trap, Esc returns focus, keyboard move to ${picked}`);
      guard.assertClean('keyboard');
    }, { headless: true, viewport: DESKTOP });

    // 26. Loading, error and empty states.
    await fs.mkdir(path.join(projectsRoot, PROJECT5), { recursive: true });
    await withPage(async (page, { context }) => {
      // The failed meta read and the deliberately refused requests below are expected.
      const guard = consoleGuard(context, { allow: [/api\/board\/meta/, /status of 500/] });
      // Skeletons while the cards are in flight.
      let release;
      const held = new Promise((r) => { release = r; });
      await page.route('**/api/board/*/cards', async (route) => { await held; await route.continue(); });
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`${sel.lane('triage')} [data-skeleton]`, { timeout: 10_000 });
      assert.equal(await page.locator(`${sel.board}[aria-busy="true"]`).count(), 1);
      await shot(page, 'gui-26a-loading');
      release();
      await waitBoard(page);
      await page.unroute('**/api/board/*/cards');

      // Init failure: a 500 on meta shows the alert with Retry; Retry recovers.
      await page.route('**/api/board/meta', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"meta exploded"}' }));
      await page.reload({ waitUntil: 'domcontentloaded' });
      const alert = page.getByRole('alert').filter({ hasText: 'Failed to initialize: meta exploded' });
      await alert.waitFor({ timeout: 10_000 });
      assert.match(await statusText(page), /^Failed to initialize: meta exploded$/);
      await shot(page, 'gui-26b-init-failed');
      await page.unroute('**/api/board/meta');
      await alert.getByRole('button', { name: 'Retry' }).click();
      await waitBoard(page);
      assert.equal(await page.locator('[data-lane]').count(), 5);
      assert.equal(await page.getByRole('alert').count(), 0);

      // A card deleted under the open board: its detail shows the refusal.
      await selectProject(page, PROJECT);
      const victim = seeded.bulk[0].id;
      const del = await fetch(`${srv.url}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'delete_card', arguments: { project: PROJECT, id: victim } }) }).then((r) => r.json());
      assert.equal(del?.result?.ok, true, JSON.stringify(del));
      await page.click(sel.tile(victim));
      await waitDialog(page);
      const dialogAlert = page.locator(sel.dialog).getByRole('alert');
      await dialogAlert.waitFor({ timeout: 10_000 });
      assert.match(await dialogAlert.textContent(), /CARD_UNKNOWN|no card|unknown/i);
      assert.equal(await statusText(page), await dialogAlert.textContent());
      await shot(page, 'gui-26c-card-read-refused');
      await closeDialog(page);

      // A refused move: the card moves underneath the open dialog, so the
      // target the dialog offers is no longer legal.
      const racer = seeded.bulk[1].id; // in done; done → todo is legal
      await refresh(page);
      await openCard(page, racer);
      const offered = await page.locator(`${sel.dialog} select[name="to"]`).inputValue();
      await post(`/api/board/${PROJECT}/cards/${racer}/move`, { to: offered });
      await page.locator(sel.dialog).getByRole('button', { name: 'Move' }).click();
      await waitDialogClosed(page);
      assert.match(await statusText(page), /^Move refused: /);
      await shot(page, 'gui-26d-move-refused');

      // A project with no epics.
      await selectProject(page, PROJECT5);
      await page.locator(sel.epicsPane).getByText('No epics yet.').waitFor({ timeout: 10_000 });
      assert.equal(await page.locator('[data-empty]').count(), 5);
      await shot(page, 'gui-26e-no-epics');
      console.log('snapped states (loading skeletons, init failure + retry, read refusal, move refused, no epics)');
      guard.assertClean('states');
    }, { headless: true, viewport: DESKTOP });
    console.log('console hygiene: every page above logged only the standalone host-URL 404s');
  } finally {
    await srv.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
