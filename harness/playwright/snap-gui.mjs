// Visual-verification harness for the code-kanban web GUI. Boots the plugin's
// own server with an isolated PROJECTS_ROOT, seeds a project through the REAL
// /api/board/* routes (so board.js / the mutex are exercised), then drives the
// golden path with a real browser and captures screenshots:
//   1. the populated board (5 columns + epics rollup)
//   2. a card's detail panel (Goal / Acceptance / Logbook + move + edit)
//   3. the board after a legal move (status surfaces the move)
//   4. a landed card's detail panel showing the stamped Commit field
//   5. the project selection surviving a reload (localStorage restore)
//   6. the plan badge on a card carrying a plan link
//   7. that card's detail panel showing the Plan section (link + file body)
//   8. the board with the "Has plan" filter on (only planned cards remain)
//   14. the edit form's Acceptance textarea prefilled one criterion per line
//   15. the read view after editing acceptance: a renamed criterion, a new
//       one, and the untouched criterion's tick surviving the {replace} round trip
//   16. per-lane scrolling: the overflowing `done` lane scrolls, the page doesn't
//   17. the lane header staying put while its body scrolls, and lanes scrolling
//       independently of one another
//   18. a lane's scroll offset surviving a re-render (Refresh)
//   19. lane ordering: priority first, then newest card number
//   20. a project whose lanes are empty, plus the narrow and short-window
//       fallbacks where the page scrolls again
//   21. epic ordering: active epics most-recently-active first, a
//       `Completed · N` separator, then completed epics; the epic <select>s
//       list completed epics in a "Completed" optgroup
//   22. an epic's plan: the `plan` badge on its epics-pane row, its detail
//       panel's Plan section (link + file body) for a project-scoped and a
//       cross-project epic, an unplanned epic showing no
//       Plan section, and a deleted plan file rendering "(file not found)"
//   23. epic rollup pills: each pill shows its lane label and its count, zero included (dimmed)
// Reuses withPage/waitForServer from the shared code-playwright harness — no
// chromium/launch logic here. Run: node harness/playwright/snap-gui.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { withPage, waitForServer } from '../../../code-playwright/browser.mjs';
import { bootKanban } from './boot-kanban.mjs';
import { plansDir, boardPlansDir } from '../../src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PROJECT = 'demo';
const PROJECT2 = 'web'; // second project, for the cross-project epic
const PROJECT3 = 'ordering'; // own project for step 21, so no other step's epics shift
const PROJECT4 = 'rollup'; // own project for step 23, so no other step's counts shift

async function ensureShotsDir() {
  await fs.mkdir(SHOTS, { recursive: true });
}

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

  // fileCard takes priority, so the level is set at the capture point. One card
  // per level (HIGH/CRITICAL/LOW/MEDIUM), plus d, which OMITS it and is therefore
  // unset. d and e are the load-bearing pair: e is a judged MEDIUM and d has
  // never been judged, and the whole point of this card is that a person can
  // tell them apart without opening either. They sit in the same column so the
  // screenshot shows them side by side. Without both, a missing badge and a
  // broken badge look identical in a screenshot.
  const a = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Design login screen', goal: 'Email + password form', acceptance: ['Matches design spec', 'Accessible labels'], epic: 'auth', priority: 'HIGH' } }, 'file a');
  const b = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Hash passwords with argon2', goal: 'No plaintext at rest', epic: 'auth', priority: 'CRITICAL' } }, 'file b');
  const c = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Build search index', goal: 'Inverted index over docs', epic: 'search', priority: 'LOW' } }, 'file c');
  const d = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Triage: spike caching layer', goal: 'Decide redis vs in-memory' } }, 'file d');
  const e = await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Rotate the signing key', goal: 'Quarterly rotation', priority: 'MEDIUM' } }, 'file e');

  // Spread cards across columns via LEGAL transitions. b reaches in-progress
  // through triage→todo→in-progress (NOT triage→in-progress, which is illegal),
  // so the In Progress column is populated and b carries an owner badge (owner
  // is set only on entering in-progress). a→todo, c→backlog, d stays in triage.
  await call(`/api/board/${PROJECT}/cards/${a.id}/move`, { method: 'POST', body: { to: 'todo' } }, 'move a → todo');
  await call(`/api/board/${PROJECT}/cards/${b.id}/move`, { method: 'POST', body: { to: 'todo' } }, 'move b → todo');
  await call(`/api/board/${PROJECT}/cards/${b.id}/move`, { method: 'POST', body: { to: 'in-progress' } }, 'move b → in-progress');
  await call(`/api/board/${PROJECT}/cards/${c.id}/move`, { method: 'POST', body: { to: 'backlog' } }, 'move c → backlog');

  // Cross-project epic spanning demo + web, with a card under it in EACH project,
  // so demo's board shows the cross-project epic row with an aggregated rollup.
  await call('/api/epics', { method: 'POST', body: { slug: 'platform', title: 'Platform', goal: 'Shared infra across services', projects: [PROJECT, PROJECT2] } }, 'cross epic platform');
  await call(`/api/board/${PROJECT}/cards`, { method: 'POST', body: { title: 'Shared logging', goal: 'One logger', epic: 'platform' } }, 'file demo platform card');
  await call(`/api/board/${PROJECT2}/cards`, { method: 'POST', body: { title: 'Config service', goal: 'Central config', epic: 'platform' } }, 'file web platform card');

  // A plan link on exactly ONE card (c, which stays put in backlog): the other
  // cards are the witness that the badge and the "Has plan" filter really
  // discriminate, rather than matching everything. The plan FILE must exist
  // before update_card will accept the link (PLAN_UNKNOWN otherwise) — the
  // board: base is <kanbanRoot>/projects/<project>/plans/.
  const planFile = path.join(plansDir(PROJECT), `${c.id}.md`);
  await fs.mkdir(path.dirname(planFile), { recursive: true });
  await fs.writeFile(planFile, `# Plan — build the search index\n\n1. Tokenize documents.\n2. Build the inverted index.\n3. Wire the query path.\n`);
  await call(`/api/board/${PROJECT}/cards/${c.id}`, { method: 'PATCH', body: { plan: `${c.id}.md` } }, 'plan link on c');

  // Bulk-fill `done` so the lane genuinely overflows a 900px-tall viewport —
  // per-lane scrolling is unobservable on a lane that fits. They all share ONE
  // priority level (unset) on purpose: within the lane the order is then the id
  // tiebreak and nothing else, which is what step 19 reads. Unset also keeps
  // them out of step 9's judged-badge count. POST /cards always files into
  // triage (the route does not forward `category`), so each chore walks the full
  // LEGAL path triage → todo → in-progress → done via call() — a refused step
  // fails loudly rather than leaving a short lane and a passing-looking scene.
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

async function main() {
  await ensureShotsDir();
  const srv = await bootKanban({ sandbox: { dirs: { PROJECTS_ROOT: 'root' } }, silent: true });
  try {
    await waitForServer(srv.url);
    const projectsRoot = srv.sandbox.dirs.PROJECTS_ROOT;
    // paths.js reads PROJECTS_ROOT at call time; point THIS process at the same
    // sandbox the server got, so plansDir() resolves the child's board dirs
    // instead of hardcoding the `.conduct/kanban/...` layout here.
    process.env.PROJECTS_ROOT = projectsRoot;
    const seeded = await seed(srv.url, projectsRoot);

    await withPage(async (page) => {
      // 1. Board: load and wait for cards to render. (app.js auto-selects the
      //    first project and loads the board; <option> elements are always
      //    "hidden" to Playwright, so wait on the rendered cards instead.)
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#project-select', { timeout: 10_000 });
      // Explicitly select demo (two projects now exist; auto-select order is not
      // guaranteed by the filesystem scan).
      await page.selectOption('#project-select', PROJECT);
      await page.waitForFunction(() => document.querySelector('#project-select')?.value === 'demo', { timeout: 10_000 });
      await page.waitForSelector('.card', { timeout: 10_000 });
      await page.waitForSelector('.epic-row', { timeout: 10_000 });
      // The cross-project epic must render with its badge on demo's board.
      await page.waitForSelector('.badge.epic-cross', { timeout: 10_000 });
      // NOTE on fullPage: true (used by every shot below). It captures the whole
      // SCROLLABLE DOCUMENT, and since 2026-0037 the lanes clip their own
      // overflow instead of stretching the page — so these shots now show only
      // the visible slice of a long lane. That is the intended new behaviour,
      // not a truncated screenshot; step 16 is what asserts it.
      await page.screenshot({ path: path.join(SHOTS, 'gui-1-board.png'), fullPage: true });
      console.log('snapped board');

      // 1b. Cross-project epic detail: open the row carrying the cross badge and
      //     confirm it renders member projects + cards from both projects.
      await page.locator('.epic-row', { has: page.locator('.badge.epic-cross') }).getByRole('button', { name: 'open' }).click();
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('#detail-overlay .detail-section h3')].some((h) => h.textContent === 'Projects'), { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-1b-cross-epic.png'), fullPage: true });
      console.log('snapped cross-epic detail');
      await page.click('#detail-overlay .overlay-close');
      await page.waitForSelector('#detail-overlay', { state: 'hidden', timeout: 10_000 });

      // 2. Card detail: open a NAMED card, wait for the overlay. Pinned to `a`
      //    rather than `.card` (the first in DOM order) because that made this
      //    step's subject depend on the priority sort — adding a card at a
      //    higher level silently retargeted the move below at an unrelated card.
      await page.click(`.card:has(.card-id:text-is("${seeded.a.id}"))`);
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.waitForSelector('.logbook li', { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-2-detail.png'), fullPage: true });
      console.log('snapped detail');

      // 3. Legal move from the detail panel: pick the first legal target, move.
      //    (Card `a`, opened above — it starts in todo, so this also populates
      //    In Progress, which step 4 then empties by landing b.)
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

      // 4. Land b (currently in-progress) with an explicit commit — the
      //    sandboxed project isn't a real git repo, so auto-capture would
      //    resolve to null; passing commit explicitly is what actually
      //    exercises the rendered Commit field.
      const landed = await fetch(`${srv.url}/api/board/${PROJECT}/cards/${seeded.b.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'done', commit: 'abc1234def5678' }),
      }).then((r) => r.json());
      if (!landed.ok) throw new Error(`landing seed step refused: ${JSON.stringify(landed)}`);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.card', { timeout: 10_000 });
      await page.click(`.card:has(.card-id:text-is("${seeded.b.id}"))`);
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.waitForSelector('.detail-section:has-text("Commit")', { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-4-detail-done-commit.png'), fullPage: true });
      console.log('snapped done detail with commit');

      // 5. Project-selection persistence: pick a project that provably differs
      //    from the default fallback (projects[0]), reload, and assert the
      //    selection survives — the second load does NO selectOption, so this is
      //    the localStorage restore path (not a re-pick). If the picked project
      //    were the default, the reload assertion would pass even without the
      //    persistence code; a non-default pick makes it a true witness.
      const projRes = await fetch(`${srv.url}/api/projects`).then((r) => r.json());
      const defaultProj = projRes.projects[0];
      const persistProj = projRes.projects.find((p) => p !== defaultProj);
      if (!persistProj) throw new Error('need ≥2 projects to discriminate the restore path');
      await page.selectOption('#project-select', persistProj);
      await page.waitForFunction((v) => document.querySelector('#project-select')?.value === v, persistProj, { timeout: 10_000 });
      await page.waitForSelector('.card', { timeout: 10_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#project-select', { timeout: 10_000 });
      await page.waitForFunction((v) => document.querySelector('#project-select')?.value === v, persistProj, { timeout: 10_000 });
      await page.waitForSelector('.card', { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-5-persisted-selection.png'), fullPage: true });
      console.log(`snapped persisted-selection after reload (restored non-default ${persistProj})`);

      // 6. Plan badge: back on demo, exactly one card carries a plan link.
      await page.selectOption('#project-select', PROJECT);
      await page.waitForFunction(() => document.querySelector('#project-select')?.value === 'demo', { timeout: 10_000 });
      await page.waitForSelector('.card .badge.plan', { timeout: 10_000 });
      const planBadges = await page.locator('.card .badge.plan').count();
      if (planBadges !== 1) throw new Error(`expected exactly 1 plan badge, saw ${planBadges}`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-6-plan-badge.png'), fullPage: true });
      console.log('snapped plan badge');

      // 7. Plan detail: the section renders the link AND the file's body, which
      //    only arrives via the detail fetch's ?includePlan=1.
      await page.click(`.card:has(.card-id:text-is("${seeded.c.id}"))`);
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.waitForSelector('.detail-section:has-text("Plan")', { timeout: 10_000 });
      await page.waitForSelector('.detail-section:has-text("Build the inverted index")', { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-7-plan-detail.png'), fullPage: true });
      console.log('snapped plan detail (link + body)');
      await page.click('#detail-overlay .overlay-close');
      await page.waitForSelector('#detail-overlay', { state: 'hidden', timeout: 10_000 });

      // 8. Has-plan filter: ticking it must drop every card WITHOUT a plan —
      //    the unplanned cards seeded above are the witness that it filters.
      const before = await page.locator('.card').count();
      await page.check('#plan-filter');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 1, { timeout: 10_000 });
      if (before <= 1) throw new Error(`filter proves nothing: only ${before} card(s) before filtering`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-8-plan-filter.png'), fullPage: true });
      console.log(`snapped has-plan filter (${before} cards -> 1)`);
      await page.uncheck('#plan-filter');
      await page.waitForFunction((n) => document.querySelectorAll('.card').length === n, before, { timeout: 10_000 });

      // 9. Priority badges: a/b/c/e were filed HIGH/CRITICAL/LOW/MEDIUM and d was
      //    filed with no priority at all. EVERY judged level badges, so a bare
      //    card means exactly one thing — nobody has judged it. The pair that
      //    matters is e (judged MEDIUM, badged) vs d (unset, bare): assert them
      //    individually, because a global count alone would still pass if the
      //    two rendered identically.
      const prioBadges = await page.locator('.badge.prio').count();
      if (prioBadges !== 4) throw new Error(`expected 4 priority badges (one per judged level), saw ${prioBadges}`);
      const mediumBadges = await page.locator('.badge.prio-medium').count();
      if (mediumBadges !== 1) throw new Error(`a judged MEDIUM must badge, saw ${mediumBadges} badge(s)`);
      const mediumOnE = await page.locator(`.card:has(.card-id:text-is("${seeded.e.id}")) .badge.prio-medium`).count();
      if (mediumOnE !== 1) throw new Error('the judged-MEDIUM card must carry a prio-medium badge');
      const badgesOnD = await page.locator(`.card:has(.card-id:text-is("${seeded.d.id}")) .badge.prio`).count();
      if (badgesOnD !== 0) throw new Error(`an unjudged card must render bare, saw ${badgesOnD} badge(s)`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-9-priority-badges.png'), fullPage: true });
      console.log('snapped priority badges (4 judged badged, unset bare)');

      // 10. The bare card's detail must say "unset" — not blank, which would read
      //     as "the field failed to load" rather than "nobody judged this".
      await page.click(`.card:has(.card-id:text-is("${seeded.d.id}"))`);
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.waitForFunction(() => {
        const h = [...document.querySelectorAll('#detail-overlay .detail-section h3')].find((x) => x.textContent === 'Priority');
        return h?.parentElement?.textContent?.includes('unset');
      }, { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-10-unset-detail.png'), fullPage: true });
      console.log('snapped unset card detail (states "unset", not blank)');

      // 11. Edit control is a SELECT over the four levels, led by an unset option
      //     whose LABEL does the prompting ('— unset —' reads as an unfinished
      //     choice). On an unjudged card it is the unset option that is selected,
      //     not a pre-filled level.
      await page.click('#detail-overlay .detail-head button');
      await page.waitForSelector('#detail-overlay select[name="priority"]', { timeout: 10_000 });
      const editOpts = await page.locator('#detail-overlay select[name="priority"] option').allTextContents();
      if (editOpts.join(',') !== '— unset —,CRITICAL,HIGH,MEDIUM,LOW') throw new Error(`edit select options: ${editOpts.join(',')}`);
      const editValue = await page.inputValue('#detail-overlay select[name="priority"]');
      if (editValue !== '') throw new Error(`an unjudged card must preselect the unset option, saw ${editValue}`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-11-edit-priority-select.png'), fullPage: true });
      console.log('snapped edit form priority select (unset preselected)');

      // 12. Judge the unjudged card through the select and confirm the badge
      //     appears on the board — the golden path, not just a static render.
      await page.selectOption('#detail-overlay select[name="priority"]', 'CRITICAL');
      await page.click('#detail-overlay button[type="submit"]');
      await page.waitForSelector('#detail-overlay', { state: 'hidden', timeout: 10_000 });
      await page.waitForSelector(`.card:has(.card-id:text-is("${seeded.d.id}")) .badge.prio-critical`, { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-12-priority-edited.png'), fullPage: true });
      console.log('snapped board after judging an unset card CRITICAL through the select');

      // 12b. And the reverse: clearing a judged card back to unset must remove
      //      its badge. Drives the GUI half of the clear-to-unset round trip
      //      (the '' option submits as null), on e — the judged MEDIUM.
      await page.click(`.card:has(.card-id:text-is("${seeded.e.id}"))`);
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.click('#detail-overlay .detail-head button');
      await page.waitForSelector('#detail-overlay select[name="priority"]', { timeout: 10_000 });
      const eValue = await page.inputValue('#detail-overlay select[name="priority"]');
      if (eValue !== 'MEDIUM') throw new Error(`a judged card must preselect its level, saw ${eValue}`);
      await page.selectOption('#detail-overlay select[name="priority"]', '');
      await page.click('#detail-overlay button[type="submit"]');
      await page.waitForSelector('#detail-overlay', { state: 'hidden', timeout: 10_000 });
      await page.waitForFunction((id) => {
        const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-id')?.textContent === id);
        return card && card.querySelectorAll('.badge.prio').length === 0;
      }, seeded.e.id, { timeout: 10_000 });
      await page.screenshot({ path: path.join(SHOTS, 'gui-12b-priority-cleared.png'), fullPage: true });
      console.log('snapped board after clearing MEDIUM -> unset (badge removed)');

      // 13. The capture point: the New-card form asks for a priority up front,
      //     but does NOT pre-answer it — a pre-selected MEDIUM would be the same
      //     fabrication as a server-side default, just through a different door.
      await page.click('#new-card-btn');
      await page.waitForSelector('#form-overlay select[name="priority"]', { timeout: 10_000 });
      const newValue = await page.inputValue('#form-overlay select[name="priority"]');
      if (newValue !== '') throw new Error(`new-card form must open on the unset option, saw ${newValue}`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-13-new-card-priority.png'), fullPage: true });
      console.log('snapped new-card form priority select (opens unset)');
      await page.click('#form-overlay .overlay-close');
      await page.waitForSelector('#form-overlay', { state: 'hidden', timeout: 10_000 });

      // 14. Acceptance is editable (2026-0020). Pre-tick card a's FIRST
      //     criterion over the API — there is no per-item toggle in the GUI,
      //     {op:'done'} is MCP/HTTP-only — then open Edit and confirm the
      //     textarea is prefilled one criterion per line.
      const preTick = await fetch(`${srv.url}/api/board/${PROJECT}/cards/${seeded.a.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acceptance: { ops: [{ op: 'done', index: 0, done: true }] } }),
      }).then((r) => r.json());
      if (!preTick.ok) throw new Error(`pre-tick seed step refused: ${JSON.stringify(preTick)}`);
      await page.click(`.card:has(.card-id:text-is("${seeded.a.id}"))`);
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.click('#detail-overlay .detail-head button');
      await page.waitForSelector('#detail-overlay textarea[name="acceptance"]', { timeout: 10_000 });
      const prefilled = await page.inputValue('#detail-overlay textarea[name="acceptance"]');
      if (prefilled !== 'Matches design spec\nAccessible labels') {
        throw new Error(`acceptance textarea not prefilled one-per-line: ${JSON.stringify(prefilled)}`);
      }
      await page.screenshot({ path: path.join(SHOTS, 'gui-14-edit-acceptance-prefilled.png'), fullPage: true });
      console.log('snapped edit form with acceptance textarea prefilled');

      // 15. Rename the SECOND (unticked) line, add a third, Save. The first
      //     line's text is left untouched, so its tick must survive the
      //     {replace} round trip — the whole reason `replace` preserves by text.
      await page.fill('#detail-overlay textarea[name="acceptance"]',
        'Matches design spec\nAccessible labels, verified\nKeyboard navigable');
      await page.click('#detail-overlay button[type="submit"]');
      await page.waitForSelector('#detail-overlay', { state: 'hidden', timeout: 10_000 });
      await page.click(`.card:has(.card-id:text-is("${seeded.a.id}"))`);
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.waitForSelector('.acceptance li', { timeout: 10_000 });
      const items = await page.locator('#detail-overlay .acceptance li').allTextContents();
      if (items.length !== 3) throw new Error(`expected 3 acceptance items after edit, saw ${items.length}: ${items.join(' | ')}`);
      if (!items.some((t) => t.includes('Accessible labels, verified'))) throw new Error(`renamed criterion missing: ${items.join(' | ')}`);
      if (!items.some((t) => t.includes('Keyboard navigable'))) throw new Error(`new criterion missing: ${items.join(' | ')}`);
      const checkedCount = await page.locator('#detail-overlay .acceptance input[type=checkbox]:checked').count();
      if (checkedCount !== 1) throw new Error(`expected exactly 1 ticked criterion to survive the round trip, saw ${checkedCount}`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-15-acceptance-edited.png'), fullPage: true });
      console.log('snapped read view after acceptance edit (renamed + added criterion, tick survived)');
      await page.click('#detail-overlay .overlay-close');
      await page.waitForSelector('#detail-overlay', { state: 'hidden', timeout: 10_000 });

      // 16. Per-lane scrolling (2026-0037). `done` holds 15 cards, far more than
      //     a 900px viewport fits, so the two halves of the claim are both
      //     observable: the PAGE must no longer stretch, and the LANE must be
      //     the thing that scrolls. Asserting only one of them would pass on a
      //     board that simply clipped its overflow.
      const geom = await page.evaluate(() => {
        const main = document.querySelector('main');
        const body = document.querySelector('.column[data-state="done"] .column-body');
        return {
          mainScroll: main.scrollHeight, mainClient: main.clientHeight,
          laneScroll: body.scrollHeight, laneClient: body.clientHeight,
        };
      });
      assert.ok(geom.mainScroll <= geom.mainClient + 1,
        `the board must fit the viewport, but main scrolls: ${geom.mainScroll} > ${geom.mainClient}`);
      assert.ok(geom.laneScroll > geom.laneClient,
        `the done lane must overflow its own box, but ${geom.laneScroll} <= ${geom.laneClient} — the scene proves nothing`);
      // fullPage:false on purpose: fullPage would expand the viewport to the
      // document, which is exactly the constraint under test.
      await page.screenshot({ path: path.join(SHOTS, 'gui-16-lane-scroll.png'), fullPage: false });
      console.log(`snapped per-lane scroll (page fits ${geom.mainScroll}<=${geom.mainClient}, done lane ${geom.laneScroll}>${geom.laneClient})`);

      // 17. The lane HEADER must stay put while its body scrolls (that is what
      //     `.column-head { flex: 0 0 auto }` buys), and the other lanes must
      //     not move with it — independent scrollers, not one shared one.
      const headBefore = await page.locator('.column[data-state="done"] .column-head').evaluate((h) => h.getBoundingClientRect().top);
      await page.evaluate(() => {
        const body = document.querySelector('.column[data-state="done"] .column-body');
        body.scrollTop = body.scrollHeight;
      });
      const headAfter = await page.locator('.column[data-state="done"] .column-head').evaluate((h) => h.getBoundingClientRect().top);
      assert.equal(headAfter, headBefore, 'the done lane header moved when its body scrolled');
      const otherOffsets = await page.evaluate(() => Object.fromEntries(
        [...document.querySelectorAll('.column')]
          .filter((c) => c.dataset.state !== 'done')
          .map((c) => [c.dataset.state, c.querySelector('.column-body').scrollTop]),
      ));
      for (const [st, top] of Object.entries(otherOffsets)) {
        assert.equal(top, 0, `scrolling done also scrolled ${st} (offset ${top}) — the lanes are not independent`);
      }
      await page.screenshot({ path: path.join(SHOTS, 'gui-17-lane-header-pinned.png'), fullPage: false });
      console.log('snapped done lane scrolled to the bottom (header pinned, other lanes at 0)');

      // 18. The offset must survive a re-render. renderBoard() rebuilds every
      //     lane with replaceChildren(), which zeroes scrollTop — so Refresh
      //     would silently yank a deep lane back to the top without the
      //     capture/restore pass in frontend/app.js.
      await page.evaluate(() => { document.querySelector('.column[data-state="done"] .column-body').scrollTop = 200; });
      await page.click('#refresh-btn');
      await page.waitForFunction(() => document.querySelectorAll('.column[data-state="done"] .card').length === 15, { timeout: 10_000 });
      const afterRefresh = await page.evaluate(() => document.querySelector('.column[data-state="done"] .column-body').scrollTop);
      assert.ok(Math.abs(afterRefresh - 200) <= 1, `lane scroll lost across the rebuild: expected ~200, saw ${afterRefresh}`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-18-lane-scroll-survives-refresh.png'), fullPage: false });
      console.log(`snapped done lane still scrolled (${afterRefresh}px) after Refresh`);

      // 19. Lane ORDERING — priority first, then card number DESCENDING. The
      //     harness asserted badge counts and text but never card order. `done`
      //     holds the judged CRITICAL (b, the OLDEST id in the lane) plus the 14
      //     unset chores, so both keys are exercised at once: an ascending
      //     tiebreak reverses the chores, and a dropped priority key sinks b.
      const doneCards = await page.$$eval('.column[data-state="done"] .card', (els) => els.map((c) => ({
        id: c.querySelector('.card-id').textContent,
        prio: c.querySelector('.badge.prio')?.textContent ?? null,
      })));
      assert.equal(doneCards.length, 15, `expected 15 cards in done, saw ${doneCards.length}`);
      assert.equal(doneCards[0].prio, 'critical', `the judged CRITICAL must lead its lane, saw ${JSON.stringify(doneCards[0])}`);
      assert.equal(doneCards[0].id, seeded.b.id, 'the leading card must be b, which holds the OLDEST id in the lane');
      const num = (id) => Number(id.split('-')[1]);
      const chores = doneCards.slice(1);
      for (const c of chores) assert.equal(c.prio, null, `expected the trailing chores to be unjudged, saw ${JSON.stringify(c)}`);
      for (let i = 1; i < chores.length; i++) {
        assert.ok(num(chores[i - 1].id) > num(chores[i].id),
          `equal-priority cards must run newest-first: ${chores[i - 1].id} then ${chores[i].id}`);
      }
      await page.screenshot({ path: path.join(SHOTS, 'gui-19-lane-order.png'), fullPage: false });
      console.log(`snapped lane ordering (${doneCards[0].id} leads, then ${chores[0].id}..${chores.at(-1).id} descending)`);

      // 20a. Empty lanes: `web` holds a single card, so four of its five lanes
      //      are empty. The '— empty —' placeholder must still render in each
      //      and the board must still fit — a stretch-to-row-height lane with a
      //      min-height floor is the case most likely to overflow.
      await page.selectOption('#project-select', PROJECT2);
      await page.waitForFunction((v) => document.querySelector('#project-select')?.value === v, PROJECT2, { timeout: 10_000 });
      await page.waitForFunction(() => document.querySelectorAll('.column-empty').length === 4, { timeout: 10_000 });
      const emptyGeom = await page.evaluate(() => {
        const main = document.querySelector('main');
        return { scroll: main.scrollHeight, client: main.clientHeight };
      });
      assert.ok(emptyGeom.scroll <= emptyGeom.client + 1,
        `an all-but-one-empty board must still fit: ${emptyGeom.scroll} > ${emptyGeom.client}`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-20a-empty-lanes.png'), fullPage: false });
      console.log('snapped a project with four empty lanes (placeholders render, board fits)');
    },{ headless: true, viewport: { width: 1440, height: 900 } });

    // 20b. Narrow window: below 980px the grid reflows to 2 columns / 3 ROWS, so
    //      the fixed-height board is deliberately opted out and the PAGE scrolls
    //      again. Assert that fallback is really active — and that nothing
    //      scrolls HORIZONTALLY, which `overflow-x: hidden` on the lane plus
    //      `overflow-wrap: anywhere` on the card is what prevents.
    await withPage(async (page) => {
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#project-select', { timeout: 10_000 });
      await page.selectOption('#project-select', PROJECT);
      await page.waitForFunction(() => document.querySelector('#project-select')?.value === 'demo', { timeout: 10_000 });
      await page.waitForSelector('.card', { timeout: 10_000 });
      const narrow = await page.evaluate(() => {
        const main = document.querySelector('main');
        const doc = document.documentElement;
        return {
          mainScroll: main.scrollHeight, mainClient: main.clientHeight,
          docScrollW: doc.scrollWidth, docClientW: doc.clientWidth,
        };
      });
      assert.ok(narrow.mainScroll > narrow.mainClient,
        `below 980px the page must scroll again, but main fits: ${narrow.mainScroll} <= ${narrow.mainClient}`);
      assert.ok(narrow.docScrollW <= narrow.docClientW + 1,
        `no horizontal page scroll allowed, saw ${narrow.docScrollW} > ${narrow.docClientW}`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-20b-narrow-page-scroll.png'), fullPage: false });
      console.log(`snapped narrow window (page scrolls ${narrow.mainScroll}>${narrow.mainClient}, no horizontal scroll)`);
    }, { headless: true, viewport: { width: 700, height: 900 } });

    // 20c. Short window: still the 5-column layout, but the viewport is shorter
    //      than .board's min-height floor, so the board stops shrinking and
    //      `main` scrolls the page — the pre-2026-0037 behaviour, kept as the
    //      escape hatch. Every lane's cards must stay REACHABLE that way.
    await withPage(async (page) => {
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#project-select', { timeout: 10_000 });
      await page.selectOption('#project-select', PROJECT);
      await page.waitForFunction(() => document.querySelector('#project-select')?.value === 'demo', { timeout: 10_000 });
      await page.waitForSelector('.card', { timeout: 10_000 });
      const short = await page.evaluate(() => {
        const main = document.querySelector('main');
        const doc = document.documentElement;
        main.scrollTop = main.scrollHeight; // reach the bottom via the fallback
        return {
          mainScroll: main.scrollHeight, mainClient: main.clientHeight, mainTop: main.scrollTop,
          docScrollW: doc.scrollWidth, docClientW: doc.clientWidth,
          lanes: [...document.querySelectorAll('.column')].map((c) => ({
            state: c.dataset.state,
            bottom: Math.round(c.getBoundingClientRect().bottom),
          })),
        };
      });
      assert.ok(short.mainScroll > short.mainClient,
        `a window shorter than the board floor must scroll the page: ${short.mainScroll} <= ${short.mainClient}`);
      assert.ok(short.mainTop > 0, 'the page-scroll fallback did not actually scroll');
      assert.ok(short.docScrollW <= short.docClientW + 1,
        `no horizontal page scroll allowed, saw ${short.docScrollW} > ${short.docClientW}`);
      for (const lane of short.lanes) {
        assert.ok(lane.bottom <= short.mainClient + 1,
          `lane ${lane.state} is still cut off after scrolling to the bottom (bottom ${lane.bottom})`);
      }
      await page.screenshot({ path: path.join(SHOTS, 'gui-20c-short-page-scroll.png'), fullPage: false });
      console.log(`snapped short window (page scrolls to ${short.mainTop}, every lane reachable)`);
    }, { headless: true, viewport: { width: 1440, height: 420 } });

    // 21. Epic ordering, seeded through the real routes (wall-clock stamps, so a
    //     few ms between steps keeps each one strictly newer). Creation order is
    //     empty → alpha-old → beta-new → shipped; then shipped's only card walks
    //     to done (completed), and LAST alpha-old's card moves, which must lift
    //     alpha-old above beta-new despite the older epic record.
    await fs.mkdir(path.join(srv.sandbox.dirs.PROJECTS_ROOT, PROJECT3), { recursive: true });
    const post = async (p, body, method = 'POST') => {
      const r = await fetch(srv.url + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
      if (!r || r.ok === false) throw new Error(`step 21 seed ${p} refused: ${JSON.stringify(r)}`);
      await new Promise((res) => setTimeout(res, 5));
      return r;
    };
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

    await withPage(async (page) => {
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#project-select', { timeout: 10_000 });
      await page.selectOption('#project-select', PROJECT3);
      await page.waitForFunction((v) => document.querySelector('#project-select')?.value === v, PROJECT3, { timeout: 10_000 });
      await page.waitForSelector('.epic-sep', { timeout: 10_000 });
      const pane = await page.evaluate(() => [...document.querySelectorAll('.epic-list > *')].map((n) => (
        n.classList.contains('epic-sep') ? `SEP:${n.textContent}` : n.querySelector('.epic-slug').textContent)));
      assert.deepEqual(pane, ['alpha-old', 'beta-new', 'empty', 'SEP:Completed · 1', 'shipped'], `epics pane order: ${pane.join(', ')}`);
      await page.locator('#epics').screenshot({ path: path.join(SHOTS, 'gui-21a-epic-order.png') });
      await page.screenshot({ path: path.join(SHOTS, 'gui-21b-epic-order-board.png'), fullPage: false });
      // The pane is capped at 25vh, so the completed group sits below the fold:
      // scroll it to the bottom to show the separator above the completed row.
      await page.evaluate(() => { const p = document.querySelector('#epics'); p.scrollTop = p.scrollHeight; });
      await page.locator('#epics').screenshot({ path: path.join(SHOTS, 'gui-21c-epic-order-completed.png') });

      // New-card <select>: a native open dropdown can't be screenshotted, so
      // read its structure — top-level options, then the Completed optgroup.
      const selectShape = (sel) => page.evaluate((s) => [...document.querySelector(s).children].map((n) => (
        n.tagName === 'OPTGROUP' ? `[${n.label}: ${[...n.children].map((o) => o.value).join(', ')}]` : n.value || '(none)')), sel);
      await page.click('#new-card-btn');
      await page.waitForSelector('#form-overlay select[name="epic"]', { timeout: 10_000 });
      const newShape = await selectShape('#form-overlay select[name="epic"]');
      assert.deepEqual(newShape, ['(none)', 'alpha-old', 'beta-new', 'empty', '[Completed: shipped]'], `new-card epic select: ${newShape.join(', ')}`);
      await page.click('#form-overlay .overlay-close');
      await page.waitForSelector('#form-overlay', { state: 'hidden', timeout: 10_000 });

      // Edit-card <select> on the shipped card keeps its (completed) epic selected.
      await page.locator('.card', { hasText: 'Shipped card' }).click();
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.click('#detail-overlay .detail-head button');
      await page.waitForSelector('#detail-overlay select[name="epic"]', { timeout: 10_000 });
      const editEpic = await page.inputValue('#detail-overlay select[name="epic"]');
      assert.equal(editEpic, 'shipped', 'edit form must keep a completed epic selected');
      console.log(`snapped epic ordering (${pane.join(' | ')}); selects: ${newShape.join(', ')}; edit keeps "${editEpic}"`);
    }, { headless: true, viewport: { width: 1440, height: 900 } });

    // 22. Epic plan. Seeded only now so steps 6–8's card-only plan counts are
    //     untouched. The HTTP epic routes take no `plan`, so attach it through
    //     the MCP bridge's create_epic (an upsert that keeps title/goal).
    const epicPlan = path.join(plansDir(PROJECT), 'epic-search.md');
    await fs.writeFile(epicPlan, '# Plan — search epic\n\nRank results by BM25.\n');
    const createEpic = async (args) => {
      const mcp = await fetch(`${srv.url}/api/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'create_epic', arguments: args }),
      }).then((x) => x.json());
      if (mcp?.result?.ok !== true) throw new Error(`step 22 seed create_epic ${args.slug} refused: ${JSON.stringify(mcp)}`);
    };
    await createEpic({ project: PROJECT, slug: 'search', title: 'Search', plan: 'epic-search.md' });
    // The cross-project epic's board: plan lives in the board-level plans dir,
    // and its detail reads through openEpic's other branch (api/epics/:slug).
    const crossPlan = path.join(boardPlansDir(), 'epic-platform.md');
    await fs.mkdir(path.dirname(crossPlan), { recursive: true });
    await fs.writeFile(crossPlan, '# Plan — platform epic\n\nOne logger, one config service.\n');
    await createEpic({ projects: [PROJECT, PROJECT2], slug: 'platform', title: 'Platform', plan: 'epic-platform.md' });

    await withPage(async (page) => {
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#project-select', { timeout: 10_000 });
      await page.selectOption('#project-select', PROJECT);
      await page.waitForFunction((v) => document.querySelector('#project-select')?.value === v, PROJECT, { timeout: 10_000 });
      await page.waitForSelector('.epic-row .badge.plan', { timeout: 10_000 });
      const epicBadges = await page.locator('.epic-row .badge.plan').count();
      assert.equal(epicBadges, 2, `expected exactly 2 epic plan badges (search + platform), saw ${epicBadges}`);
      const searchRow = '.epic-row:has(.epic-slug:text-is("search"))';
      assert.equal(await page.locator(`${searchRow} .badge.plan`).count(), 1, 'the plan badge must sit on the search row');
      assert.equal(await page.locator(`${searchRow} .badge.plan`).getAttribute('title'), 'board:epic-search.md');
      assert.equal(await page.locator('.epic-row:has(.epic-slug:text-is("auth")) .badge.plan').count(), 0, 'auth is unplanned');
      await page.locator('#epics').screenshot({ path: path.join(SHOTS, 'gui-22a-epic-plan-badge.png') });

      const openEpicDetail = async (slug) => {
        await page.click(`.epic-row:has(.epic-slug:text-is("${slug}")) button`);
        await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      };
      const closeDetail = async () => {
        await page.click('#detail-overlay .overlay-close');
        await page.waitForSelector('#detail-overlay', { state: 'hidden', timeout: 10_000 });
      };
      const planH3 = '#detail-overlay .detail-section h3:text-is("Plan")';

      await openEpicDetail('search');
      await page.waitForSelector('#detail-overlay .detail-section:has-text("Rank results by BM25")', { timeout: 10_000 });
      assert.equal(await page.locator('#detail-overlay .plan-link').textContent(), 'board:epic-search.md');
      await page.screenshot({ path: path.join(SHOTS, 'gui-22b-epic-plan-detail.png'), fullPage: false });
      await closeDetail();

      // Cross-project branch: the row's slug text is "platform · demo, web".
      await page.click('.epic-row:has(.badge.epic-cross) button');
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      await page.waitForSelector('#detail-overlay .detail-section:has-text("One logger, one config service.")', { timeout: 10_000 });
      assert.equal(await page.locator('#detail-overlay .plan-link').textContent(), 'board:epic-platform.md');
      await page.screenshot({ path: path.join(SHOTS, 'gui-22d-cross-epic-plan-detail.png'), fullPage: false });
      await closeDetail();

      await openEpicDetail('auth');
      assert.equal(await page.locator(planH3).count(), 0, 'an unplanned epic must show no Plan section');
      await closeDetail();

      await fs.rm(epicPlan);
      await openEpicDetail('search');
      await page.waitForSelector('#detail-overlay .detail-section:has-text("(file not found)")', { timeout: 10_000 });
      assert.equal(await page.locator('#detail-overlay .plan-link').textContent(), 'board:epic-search.md');
      await page.screenshot({ path: path.join(SHOTS, 'gui-22c-epic-plan-missing.png'), fullPage: false });
      console.log('snapped epic plan (badge, detail body, unplanned witness, missing file)');
    }, { headless: true, viewport: { width: 1440, height: 900 } });

    // 23. Rollup pills. Distinct per-lane counts (1/2/3/4) so a wrong or swapped
    //     number fails, plus an empty `done` lane for the zero rendering.
    await fs.mkdir(path.join(srv.sandbox.dirs.PROJECTS_ROOT, PROJECT4), { recursive: true });
    const R = `/api/board/${PROJECT4}`;
    await post(`${R}/epics`, { slug: 'counts', title: 'Rollup counts' });
    // Every POST files into triage; each entry is the legal walk to the card's lane.
    const walks = [[], ['backlog'], ['backlog'], ['todo'], ['todo'], ['todo'],
      ['todo', 'in-progress'], ['todo', 'in-progress'], ['todo', 'in-progress'], ['todo', 'in-progress']];
    for (const [i, moves] of walks.entries()) {
      const c = await post(`${R}/cards`, { title: `Rollup card ${i + 1}`, epic: 'counts' });
      for (const to of moves) await post(`${R}/cards/${c.id}/move`, { to });
    }

    await withPage(async (page) => {
      await page.goto(srv.url + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#project-select', { timeout: 10_000 });
      await page.selectOption('#project-select', PROJECT4);
      await page.waitForFunction((v) => document.querySelector('#project-select')?.value === v, PROJECT4, { timeout: 10_000 });
      const row = '.epic-row:has(.epic-slug:text-is("counts"))';
      await page.waitForSelector(`${row} .rollup-pill`, { timeout: 10_000 });
      // Order follows STATES (src/paths.js, served as meta.states); labels are ROLLUP_LABEL (frontend/app.js).
      const expected = [['tr: 1', '1', 'false'], ['bk: 2', '2', 'false'], ['td: 3', '3', 'false'], ['ip: 4', '4', 'false'], ['dn: 0', '0', 'true']];
      const readPills = (sel) => page.locator(sel).evaluateAll((ns) => ns.map((n) => [n.textContent, n.querySelector('b')?.textContent ?? null, n.dataset.zero]));
      const pane = await readPills(`${row} .rollup-pill`);
      assert.deepEqual(pane, expected, `epics-pane rollup pills: ${JSON.stringify(pane)}`);
      await page.locator('#epics').screenshot({ path: path.join(SHOTS, 'gui-23a-rollup-counts.png') });

      await page.click(`${row} button`);
      await page.waitForSelector('#detail-overlay:not(.hidden) .detail-title', { timeout: 10_000 });
      const detail = await readPills('#detail-overlay .rollup-pill');
      assert.deepEqual(detail, expected, `epic-detail rollup pills: ${JSON.stringify(detail)}`);
      await page.screenshot({ path: path.join(SHOTS, 'gui-23b-rollup-counts-detail.png'), fullPage: false });
      console.log('snapped rollup pill counts (pane + epic detail)');
    }, { headless: true, viewport: { width: 1440, height: 900 } });
  } finally {
    await srv.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });