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
// Reuses withPage/waitForServer from the shared code-playwright harness — no
// chromium/launch logic here. Run: node harness/playwright/snap-gui.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { withPage, waitForServer } from '../../../code-playwright/browser.mjs';
import { bootKanban } from './boot-kanban.mjs';
import { plansDir } from '../../src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PROJECT = 'demo';
const PROJECT2 = 'web'; // second project, for the cross-project epic

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

  return { a, b, c, d, e };
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
      await page.waitForSelector('.badge.plan', { timeout: 10_000 });
      const planBadges = await page.locator('.badge.plan').count();
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
    },{ headless: true, viewport: { width: 1440, height: 900 } });
  } finally {
    await srv.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });