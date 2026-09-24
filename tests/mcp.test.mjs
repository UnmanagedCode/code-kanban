import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshRoot, cleanup } from './_helpers.mjs';
import { plansDir } from '../src/paths.js';
import * as mcp from '../src/mcp.js';
import { _setProjectFetcher } from '../src/projects.js';

function useProjects(names) { _setProjectFetcher(async () => names); }

test('empty tool -> 400 {error}', async () => {
  const res = await mcp.handle({ tool: '', arguments: {} });
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test('unknown tool -> 200 {error}', async () => {
  const res = await mcp.handle({ tool: 'nope', arguments: {} });
  assert.equal(res.status, 200);
  assert.match(res.body.error, /unknown tool/);
});

test('success rides in {result}', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const res = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 't' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.ok, true);
    assert.ok(res.body.result.id);
  } finally { await cleanup(root); }
});

test('domain refusal rides in {result:{ok:false}}, not {error}', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const res = await mcp.handle({ tool: 'list_cards', arguments: { project: 'ghost' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.error, undefined);
    assert.equal(res.body.result.ok, false);
    assert.equal(res.body.result.code, 'PROJECT_UNKNOWN');
  } finally { await cleanup(root); }
});

test('cross-project epic via mcp: create with projects, read without project', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api']);
  try {
    const c = await mcp.handle({ tool: 'create_epic', arguments: { projects: ['web', 'api'], slug: 'platform', title: 'Platform' } });
    assert.equal(c.body.result.ok, true);
    await mcp.handle({ tool: 'file_card', arguments: { project: 'api', title: 't', epic: 'platform' } });

    // read_epic rides the raw-text channel ({meta,text}) — see the read_epic
    // tests below; the epic/cards metadata it asserts here lives in `meta`.
    const re = await mcp.handle({ tool: 'read_epic', arguments: { slug: 'platform' } });
    assert.equal(re.body.meta.ok, true);
    assert.deepEqual(re.body.meta.epic.projects, ['web', 'api']);
    assert.equal(re.body.meta.cards.length, 1);

    // Conflict rides in {result:{ok:false}}, not {error}.
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'web', slug: 'auth', title: 'Auth' } });
    const clash = await mcp.handle({ tool: 'create_epic', arguments: { projects: ['web', 'api'], slug: 'auth', title: 'Auth X' } });
    assert.equal(clash.body.error, undefined);
    assert.equal(clash.body.result.code, 'EPIC_CONFLICT');
  } finally { await cleanup(root); }
});

test('caller.sessionId is threaded into owner-scoped tools', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'o' } });
    const id = f.body.result.id;
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'todo' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'in-progress', owner: 'sid-123' } });

    // M1 — log_card takes no id; the card is resolved from caller.sessionId,
    // which only reaches board.js if the dispatch threads it through.
    const res = await mcp.handle(
      { tool: 'log_card', arguments: { project: 'demo', entry: 'via-mcp' }, caller: { sessionId: 'sid-123' } },
    );
    assert.equal(res.body.result.ok, true);
    // read_card_log' entries ride the raw-text channel, not {result.entries}.
    const log = await mcp.handle({ tool: 'read_card_log', arguments: { project: 'demo', id } });
    assert.match(log.body.text[0], /via-mcp/);
  } finally { await cleanup(root); }
});

// file_card's dispatch spreads `...a`, so a new argument needs no mcp.js edit —
// this pins that the `plan` param actually survives the spread and that the
// result (incl. the new `plan` key) rides the plain {result} envelope.
test('file_card via mcp: an absolute plan is ingested and reported in {result}', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kanban-src-'));
  try {
    const source = path.join(srcDir, 'wake.md');
    fs.writeFileSync(source, '# plan from the wake\n');
    const res = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 't', plan: source } });
    assert.equal(res.status, 200);
    assert.equal(res.body.error, undefined);
    const { ok, id, plan } = res.body.result;
    assert.equal(ok, true);
    assert.ok(id);
    assert.equal(plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(path.join(plansDir('demo'), `${id}.md`), 'utf8'), '# plan from the wake\n');
  } finally { fs.rmSync(srcDir, { recursive: true, force: true }); await cleanup(root); }
});

test('delete_card via mcp: happy path removes the card, unknown id rides in {result:{ok:false}}', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 't' } });
    const id = f.body.result.id;

    const del = await mcp.handle({ tool: 'delete_card', arguments: { project: 'demo', id } });
    assert.equal(del.body.result.ok, true);

    const missing = await mcp.handle({ tool: 'delete_card', arguments: { project: 'demo', id } });
    assert.equal(missing.body.error, undefined);
    assert.equal(missing.body.result.ok, false);
    assert.equal(missing.body.result.code, 'CARD_UNKNOWN');
  } finally { await cleanup(root); }
});

test('move_card forwards an explicit commit arg through to the stamped card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 't' } });
    const id = f.body.result.id;
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'todo' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'in-progress', owner: 'w' } });
    const mv = await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'done', commit: 'abc123' } });
    assert.equal(mv.body.result.ok, true);

    const r = await mcp.handle({ tool: 'read_card', arguments: { project: 'demo', id } });
    assert.equal(r.body.meta.card.commit, 'abc123');
  } finally { await cleanup(root); }
});

test('read_card includePlan: card body then plan body, two RAW blocks in that order', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'planned', goal: 'ship it' } });
    const id = f.body.result.id;
    const file = path.join(plansDir('demo'), 'p.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# plan\n\nmulti-line prose\n');
    await mcp.handle({ tool: 'update_card', arguments: { project: 'demo', id, fields: { plan: 'p.md' } } });

    const r = await mcp.handle({ tool: 'read_card', arguments: { project: 'demo', id, includePlan: true } });
    // Both bodies ride the host's raw-text channel ({meta,text}), NOT {result} —
    // so neither is ever JSON-escaped into one line.
    assert.equal(r.body.result, undefined);
    assert.equal(r.body.text.length, 2);
    assert.match(r.body.text[0], /^## Goal\n/);          // card body first…
    assert.equal(r.body.text[1], '# plan\n\nmulti-line prose\n'); // …plan verbatim second
    assert.equal(r.body.meta.ok, true);
    assert.equal('plan_body' in r.body.meta, false);
    assert.equal(r.body.meta.plan_path, file);
    assert.equal(r.body.meta.plan_truncated, false);
    assert.equal(r.body.meta.plan_missing, false);
    assert.equal(r.body.meta.card.plan, 'board:p.md');
  } finally { await cleanup(root); }
});

// Rewritten under 2026-0010: read_card now ALWAYS takes the {meta,text} path
// (the card body is unconditional), so there is no {result} fallback left to
// pin — what this pins instead is that a card with no readable plan gets
// exactly ONE block, the card body.
test('read_card without a readable plan body emits the card body alone (one block)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'unplanned' } });
    const id = f.body.result.id;
    const plain = await mcp.handle({ tool: 'read_card', arguments: { project: 'demo', id } });
    assert.equal(plain.body.result, undefined);
    assert.equal(plain.body.meta.ok, true);
    assert.equal(plain.body.text.length, 1);
    // includePlan on a card with no link: plan_body is null (not a string), so
    // there is no second raw block — and no plan_body key on meta either.
    const asked = await mcp.handle({ tool: 'read_card', arguments: { project: 'demo', id, includePlan: true } });
    assert.equal(asked.body.text.length, 1);
    assert.equal(asked.body.meta.plan_body, null);
    assert.equal(asked.body.meta.plan_missing, false);
  } finally { await cleanup(root); }
});

// Three distinct `plan_body` outcomes, and what each leaves in meta. The empty
// case is the subtle one: '' IS a string, so it is promoted off meta, but an
// empty body emits no block — so meta ends up with no `plan_body` key and
// plan_missing:false. Pinned deliberately; see docs/protocol.md.
test('read_card plan_body: read vs empty file vs no link, and the meta signal for each', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const mk = async (title, contents) => {
      const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title } });
      const id = f.body.result.id;
      if (contents !== null) {
        const file = path.join(plansDir('demo'), `${title}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
        await mcp.handle({ tool: 'update_card', arguments: { project: 'demo', id, fields: { plan: `${title}.md` } } });
      }
      return mcp.handle({ tool: 'read_card', arguments: { project: 'demo', id, includePlan: true } });
    };

    // A real body: promoted to a block, key gone from meta.
    const full = await mk('full', 'real prose\n');
    assert.equal(full.body.text.length, 2);
    assert.equal('plan_body' in full.body.meta, false);
    assert.equal(full.body.meta.plan_missing, false);

    // An EMPTY plan file: promoted (typeof '' === 'string') but no block emitted.
    const empty = await mk('empty', '');
    assert.equal(empty.body.text.length, 1);            // card body only
    assert.equal('plan_body' in empty.body.meta, false); // promoted out, not left as ''
    assert.equal(empty.body.meta.plan_missing, false);   // the file DOES exist
    assert.ok(empty.body.meta.plan_path);                // …and this is how you tell

    // No link at all: plan_body:null is NOT a string, so it stays in meta.
    const none = await mk('none', null);
    assert.equal(none.body.text.length, 1);
    assert.equal('plan_body' in none.body.meta, true);
    assert.equal(none.body.meta.plan_body, null);
    assert.equal(none.body.meta.plan_path, null);
  } finally { await cleanup(root); }
});

test('read_card card body is real markdown; the JSON block keeps only branchable scalars', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const goal = 'Make it read well.\n\nSecond paragraph with `- [ ]` looking text.';
    const f = await mcp.handle({
      tool: 'file_card',
      arguments: { project: 'demo', title: 'prose', goal, acceptance: ['first crit', 'second crit'] },
    });
    const id = f.body.result.id;
    const r = await mcp.handle({ tool: 'read_card', arguments: { project: 'demo', id } });

    assert.equal(r.body.result, undefined);
    assert.equal(r.body.text.length, 1);
    const body = r.body.text[0];
    assert.match(body, /^## Goal\n/);
    assert.ok(body.includes(goal));              // prose verbatim, not escaped
    assert.ok(body.includes('- [ ] first crit')); // real checkboxes
    assert.ok(body.includes('- [ ] second crit'));
    assert.match(body, /## Logbook\n- .*filed/);
    // The three body sections left the JSON block…
    assert.equal('goal' in r.body.meta.card, false);
    assert.equal('acceptance' in r.body.meta.card, false);
    assert.equal('logbook' in r.body.meta.card, false);
    // …and every branchable scalar stayed (task stays nested and complete).
    assert.equal('task' in r.body.meta, false); // 2026-0028: `meta.card` only, no pre-rename twin
    assert.equal(r.body.meta.card.id, id);
    assert.equal(r.body.meta.card.title, 'prose');
    assert.equal(r.body.meta.card.state, 'triage');
    assert.ok(r.body.meta.card.updated);
    assert.equal(r.body.meta.plan_path, null);
  } finally { await cleanup(root); }
});

test('read_card logTail is honoured in the card-body text block', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'logged' } });
    const id = f.body.result.id;
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'todo' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'in-progress', owner: 'w' } });

    const all = await mcp.handle({ tool: 'read_card', arguments: { project: 'demo', id } });
    const logLines = (t) => t.split('## Logbook\n')[1].split('\n').filter((l) => l.startsWith('- '));
    assert.equal(logLines(all.body.text[0]).length, 3);

    // The body is RENDERED from the (sliced) task object, never read off disk —
    // the file still holds all three entries.
    const tail = await mcp.handle({ tool: 'read_card', arguments: { project: 'demo', id, logTail: 1 } });
    const tailed = logLines(tail.body.text[0]);
    assert.equal(tailed.length, 1);
    assert.match(tailed[0], /in-progress/);
  } finally { await cleanup(root); }
});

test('read_card_log: entries become a bulleted text block, meta keeps total + count', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'p' } });
    const id = f.body.result.id;
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'todo' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'in-progress', owner: 'w' } });
    await mcp.handle({ tool: 'log_card', arguments: { project: 'demo', id, entry: 'third' } });

    const all = await mcp.handle({ tool: 'read_card_log', arguments: { project: 'demo', id } });
    assert.equal(all.body.result, undefined);
    assert.equal('entries' in all.body.meta, false);
    assert.equal(all.body.meta.total, 4);
    assert.equal(all.body.meta.count, 4);
    const lines = all.body.text[0].split('\n');
    assert.equal(lines.length, 4);
    assert.ok(lines.every((l) => l.startsWith('- ')));
    assert.match(lines[0], /third/);       // most-recent first
    assert.match(lines[3], /filed/);

    // limit shrinks count but not total.
    const some = await mcp.handle({ tool: 'read_card_log', arguments: { project: 'demo', id, limit: 2 } });
    assert.equal(some.body.meta.total, 4);
    assert.equal(some.body.meta.count, 2);
    assert.equal(some.body.text[0].split('\n').length, 2);
  } finally { await cleanup(root); }
});

test('read_card_log with zero entries: metadata block only, no empty text block', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'p' } });
    const id = f.body.result.id;
    const res = await mcp.handle({ tool: 'read_card_log', arguments: { project: 'demo', id, limit: 0 } });
    assert.equal(res.body.text.length, 0);
    assert.equal(res.body.meta.count, 0);
    assert.equal(res.body.meta.total, 1);
  } finally { await cleanup(root); }
});

test('read_epic: goal prose becomes the text block, cards stay a JSON array', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const goal = 'Unify the reads.\n\nWhy: LLMs read markdown.';
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'reads', title: 'Reads', goal } });
    await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 't', epic: 'reads' } });

    const r = await mcp.handle({ tool: 'read_epic', arguments: { project: 'demo', slug: 'reads' } });
    assert.equal(r.body.result, undefined);
    assert.equal(r.body.text.length, 1);
    assert.equal(r.body.text[0], goal);
    assert.equal('goal' in r.body.meta.epic, false);
    assert.equal(r.body.meta.epic.slug, 'reads');
    assert.equal(r.body.meta.epic.title, 'Reads');
    assert.ok(r.body.meta.epic.rollup);
    assert.equal(Array.isArray(r.body.meta.cards), true);
    assert.equal(r.body.meta.cards[0].title, 't');
  } finally { await cleanup(root); }
});

test('read_epic with no goal: metadata block only', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'bare', title: 'Bare' } });
    const r = await mcp.handle({ tool: 'read_epic', arguments: { project: 'demo', slug: 'bare' } });
    assert.equal(r.body.text.length, 0);
    assert.equal(r.body.meta.epic.slug, 'bare');
  } finally { await cleanup(root); }
});

// 2026-0023: list_cards now rides the raw-text channel like every other
// prose-bearing read, and hides `done` by default. The fixture deliberately
// contains BOTH done and non-done cards, with all-distinct lane counts, so a
// lane-key mixup or a "hide unconditionally" mutant cannot survive.
async function fileListingFixture() {
  const mk = async (title, category) => {
    const r = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title, category } });
    return r.body.result.id;
  };
  await mk('triage-1');
  await mk('backlog-1', 'backlog');
  await mk('backlog-2', 'backlog');
  await mk('todo-1', 'todo');
  await mk('todo-2', 'todo');
  await mk('todo-3', 'todo');
  const doneIds = [];
  for (let i = 0; i < 4; i += 1) {
    const id = await mk(`done-${i}`, 'todo');
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'in-progress' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id, to: 'done' } });
    doneIds.push(id);
  }
  return doneIds;
}

test('list_cards default: done is hidden, counts cover all five lanes', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const doneIds = await fileListingFixture();
    const r = await mcp.handle({ tool: 'list_cards', arguments: { project: 'demo' } });
    assert.equal(r.body.result, undefined);
    assert.equal(Array.isArray(r.body.text), true);
    assert.equal(r.body.text.length, 1);
    assert.equal('cards' in r.body.meta, false);
    assert.deepEqual(r.body.meta, {
      ok: true,
      counts: { triage: 1, backlog: 2, todo: 3, 'in-progress': 0, done: 4 },
      shown: 6,
      done_hidden: 4,
    });
    assert.equal(
      r.body.text[0].split('\n')[0],
      "CARDS demo — 6 shown · 4 done hidden (state:'done' to read them; includeDone:true for every lane)",
    );
    for (const id of doneIds) assert.equal(r.body.text[0].includes(id), false, `${id} must be hidden`);
  } finally { await cleanup(root); }
});

test("list_cards state:'done' still returns exactly that lane", async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const doneIds = await fileListingFixture();
    const r = await mcp.handle({ tool: 'list_cards', arguments: { project: 'demo', state: 'done' } });
    assert.equal(r.body.text[0].split('\n')[0], 'CARDS demo — 4 shown · state done');
    assert.ok(r.body.text[0].includes('▸ done (4)'));
    for (const id of doneIds) assert.ok(r.body.text[0].includes(id), `${id} must be present`);
    assert.deepEqual(r.body.meta, { ok: true, counts: { done: 4 }, shown: 4, done_hidden: 0 });
  } finally { await cleanup(root); }
});

test('list_cards includeDone:true returns every lane', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await fileListingFixture();
    const r = await mcp.handle({ tool: 'list_cards', arguments: { project: 'demo', includeDone: true } });
    assert.ok(r.body.text[0].includes('▸ done (4)'));
    assert.equal(r.body.text[0].split('\n')[0], 'CARDS demo — 10 shown · every lane');
    assert.equal(r.body.meta.done_hidden, 0);
    assert.deepEqual(Object.keys(r.body.meta.counts).sort(), ['backlog', 'done', 'in-progress', 'todo', 'triage'].sort());
  } finally { await cleanup(root); }
});

test('list_cards includeDone with a non-boolean value hides done — nothing is ever hidden silently', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await fileListingFixture();
    const r = await mcp.handle({ tool: 'list_cards', arguments: { project: 'demo', includeDone: 'true' } });
    assert.equal(r.body.text[0].includes('▸ done'), false);
    assert.match(r.body.text[0].split('\n')[0], /done hidden/);
  } finally { await cleanup(root); }
});

// Anti-correlated with insertion order: filing LOW, unset, CRITICAL, MEDIUM in
// that sequence means ids ascend in that same order, but the rendered order
// must be CRITICAL, MEDIUM, LOW, unset — only a correct comparator produces
// this; a mutant ranking unset first (or filing/id order) dies.
test('list_cards: priority sort within a lane, unjudged sorts last', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const low = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'low', priority: 'LOW' } });
    const unset = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'unset' } });
    const critical = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'critical', priority: 'CRITICAL' } });
    const medium = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'medium', priority: 'MEDIUM' } });

    const r = await mcp.handle({ tool: 'list_cards', arguments: { project: 'demo' } });
    const laneLines = r.body.text[0].split('\n').filter((l) => l.startsWith('    '));
    const ids = laneLines.map((l) => l.trim().split(/\s+/)[0]);
    assert.deepEqual(ids, [
      critical.body.result.id,
      medium.body.result.id,
      low.body.result.id,
      unset.body.result.id,
    ]);
  } finally { await cleanup(root); }
});

// Omit-empty round trip on real board.js-produced summaries, not just
// hand-written fixtures: one bare row, one row carrying all four optional
// tail facts (epic, owner, deps, plan).
test('list_cards: tail facts are omitted when unset and present when set, on real data', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'auth', title: 'Auth' } });
    const bare = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'bare-row' } });
    const bareId = bare.body.result.id;
    const dep = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'dep-target' } });

    const planFile = path.join(plansDir('demo'), 'p.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, '# a real plan\n');
    const rich = await mcp.handle({
      tool: 'file_card',
      arguments: { project: 'demo', title: 'rich-row', epic: 'auth', depends_on: [dep.body.result.id], category: 'todo', plan: 'p.md' },
    });
    const richId = rich.body.result.id;
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id: richId, to: 'in-progress', owner: 'w-1' } });

    const r = await mcp.handle({ tool: 'list_cards', arguments: { project: 'demo' } });
    const bareLine = r.body.text[0].split('\n').find((l) => l.includes(bareId));
    const richLine = r.body.text[0].split('\n').find((l) => l.includes(richId));
    assert.ok(bareLine, 'bare row present');
    for (const kw of ['epic', 'owner', 'deps', 'plan']) assert.equal(bareLine.includes(kw), false, `bare row must omit ${kw}`);
    assert.ok(richLine, 'rich row present');
    assert.ok(richLine.includes('epic auth'));
    assert.ok(richLine.includes('owner w-1'));
    assert.ok(richLine.includes(`deps ${dep.body.result.id}`));
    assert.match(richLine, /plan /);
  } finally { await cleanup(root); }
});

test('list_cards and list_epics refusals stay on {result} — {state} still reaches the one validator', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r1 = await mcp.handle({ tool: 'list_cards', arguments: { project: 'demo', state: 'nope' } });
    assert.equal(r1.body.meta, undefined);
    assert.equal(r1.body.text, undefined);
    assert.equal(r1.body.result.ok, false);
    assert.equal(r1.body.result.code, 'INVALID_STATE');

    const r2 = await mcp.handle({ tool: 'list_epics', arguments: { project: 'ghost' } });
    assert.equal(r2.body.meta, undefined);
    assert.equal(r2.body.text, undefined);
    assert.equal(r2.body.result.ok, false);
    assert.equal(r2.body.result.code, 'PROJECT_UNKNOWN');
  } finally { await cleanup(root); }
});

test('list_epics rides the raw-text channel too: {ok, count} meta plus one text block', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api']);
  try {
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'web', slug: 'reads', title: 'Reads' } });
    await mcp.handle({ tool: 'file_card', arguments: { project: 'web', title: 't1', epic: 'reads' } });
    await mcp.handle({ tool: 'create_epic', arguments: { projects: ['web', 'api'], slug: 'platform', title: 'Platform' } });
    const t2 = await mcp.handle({ tool: 'file_card', arguments: { project: 'api', title: 't2', epic: 'platform', category: 'todo' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'api', id: t2.body.result.id, to: 'in-progress' } });

    const r = await mcp.handle({ tool: 'list_epics', arguments: { project: 'web' } });
    assert.equal(r.body.result, undefined);
    assert.equal(r.body.text.length, 1);
    assert.equal('epics' in r.body.meta, false);
    assert.deepEqual(r.body.meta, { ok: true, count: 2 });
    assert.match(r.body.text[0], /▸ reads/);
    assert.match(r.body.text[0], /▸ platform/);
    assert.match(r.body.text[0], /cross: web, api/);
    // Nothing is completed yet, so no separator.
    assert.doesNotMatch(r.body.text[0], /── completed/);

    // Pins: once an epic is completed the text carries the separator right
    // above it, and meta stays exactly {ok, count}.
    await mcp.handle({ tool: 'move_card', arguments: { project: 'api', id: t2.body.result.id, to: 'done' } });
    const r2 = await mcp.handle({ tool: 'list_epics', arguments: { project: 'web' } });
    assert.deepEqual(r2.body.meta, { ok: true, count: 2 });
    assert.match(r2.body.text[0], /── completed \(1\) ──\n▸ platform/);
  } finally { await cleanup(root); }
});

// The hidden-count and shown counts are scoped to the epic, not the whole
// board — a card outside `epic:'auth'` must never contribute to either.
test('list_cards epic filter: counts and done-hidden are epic-scoped, not board-wide', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'auth', title: 'Auth' } });
    // Board noise outside the epic: one extra done card that must not count.
    const noise = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'noise', category: 'todo' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id: noise.body.result.id, to: 'in-progress' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id: noise.body.result.id, to: 'done' } });

    await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'auth-triage', epic: 'auth' } });
    const authTodo = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'auth-todo', epic: 'auth', category: 'todo' } });
    const authDone = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 'auth-done', epic: 'auth', category: 'todo' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id: authDone.body.result.id, to: 'in-progress' } });
    await mcp.handle({ tool: 'move_card', arguments: { project: 'demo', id: authDone.body.result.id, to: 'done' } });

    const r = await mcp.handle({ tool: 'list_cards', arguments: { project: 'demo', epic: 'auth' } });
    assert.match(r.body.text[0].split('\n')[0], /· epic auth/);
    assert.equal(r.body.meta.shown, 2); // auth-triage + auth-todo, not the noise card
    assert.equal(r.body.meta.done_hidden, 1); // only auth's own done card
    assert.equal(r.body.text[0].includes(noise.body.result.id), false);
    assert.equal(r.body.text[0].includes(authTodo.body.result.id), true);
  } finally { await cleanup(root); }
});

// EVERY raw-text tool, not just read_card: shapeBody's `ok === true` guard is
// what keeps a refusal in {result}. Without it the {ok:false,code} object moves
// into `meta` with no `result` key, breaking any consumer branching on
// `body.result.code`.
// 2026-0020: update_card's fields.acceptance nested op object over the MCP
// envelope. fields is spread verbatim (no host-side schema coercion — see
// .wiki/gotchas/flat-inputschema-constraint.md), so the nested shape must
// survive untouched, and an edited list must render as real checkboxes in the
// raw-text card body.
test('update_card acceptance ops over the MCP surface render as real checkboxes on read_card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 't', acceptance: ['a', 'b'] } });
    const id = f.body.result.id;
    const u = await mcp.handle({
      tool: 'update_card',
      arguments: {
        project: 'demo', id,
        fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }, { op: 'add', text: 'c' }] } },
      },
    });
    assert.equal(u.body.result.ok, true);

    const r = await mcp.handle({ tool: 'read_card', arguments: { project: 'demo', id } });
    assert.equal(r.body.text.length, 1);
    const body = r.body.text[0];
    assert.ok(body.includes('- [x] a'), body);
    assert.ok(body.includes('- [ ] b'), body);
    assert.ok(body.includes('- [ ] c'), body);
  } finally { await cleanup(root); }
});

test('an acceptance refusal rides in {result:{ok:false}}, not {error}', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_card', arguments: { project: 'demo', title: 't', acceptance: ['a'] } });
    const id = f.body.result.id;
    const r = await mcp.handle({
      tool: 'update_card',
      arguments: { project: 'demo', id, fields: { acceptance: ['a', 'b'] } }, // the bare-array guess
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.error, undefined);
    assert.equal(r.body.result.ok, false);
    assert.equal(r.body.result.code, 'INVALID_STATE');
    assert.equal(r.body.result.reason, 'acceptance must be {ops:[…]}, {replace:[…]}, or null');
  } finally { await cleanup(root); }
});

test('a refusal on any raw-text tool keeps the plain {result} path', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const cases = [
      ['read_card', { project: 'demo', id: 'nope' }, 'CARD_UNKNOWN'],
      ['read_card_log', { project: 'demo', id: 'nope' }, 'CARD_UNKNOWN'],
      ['read_epic', { project: 'demo', slug: 'nope' }, 'EPIC_UNKNOWN'],
    ];
    for (const [tool, args, code] of cases) {
      const r = await mcp.handle({ tool, arguments: args });
      assert.equal(r.body.meta, undefined, `${tool}: no meta`);
      assert.equal(r.body.text, undefined, `${tool}: no text`);
      assert.equal(r.body.result.ok, false, `${tool}: ok:false`);
      assert.equal(r.body.result.code, code, `${tool}: code`);
    }
  } finally { await cleanup(root); }
});

// ---- read_epic / read_card_log over an epic (2026-0025) ----------------

test('read_epic emits goal, logbook and plan_body as three ORDERED text blocks', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const goal = 'Unify the reads.\n\nWhy: LLMs read markdown.';
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'reads', title: 'Reads', goal } });
    const file = path.join(plansDir('demo'), 'p.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# the strategy\n');
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'reads', title: 'Reads', plan: 'board:p.md' } });
    await mcp.handle({ tool: 'log_epic', arguments: { project: 'demo', slug: 'reads', entry: 'first card landed' } });

    const r = await mcp.handle({ tool: 'read_epic', arguments: { project: 'demo', slug: 'reads', includePlan: true } });
    assert.equal(r.body.result, undefined);
    assert.equal(r.body.text.length, 3);
    assert.equal(r.body.text[0], goal);                    // 1. the goal, verbatim
    assert.ok(r.body.text[1].startsWith('- '));            // 2. the logbook, as a - list
    assert.match(r.body.text[1], /first card landed/);
    assert.equal(r.body.text[2], '# the strategy\n');      // 3. the plan body, verbatim
    // Both prose halves left the JSON block; the plan LINK — a scalar a caller
    // branches on — stayed in it.
    assert.equal('goal' in r.body.meta.epic, false);
    assert.equal('logbook' in r.body.meta.epic, false);
    assert.equal(r.body.meta.epic.plan, 'board:p.md');
    assert.equal(r.body.meta.plan_path, file);
    assert.equal('plan_body' in r.body.meta, false);       // promoted out
    assert.equal(Array.isArray(r.body.meta.cards), true);  // cards stay JSON
    // The goal preservation survives the re-upsert that only set `plan`.
    assert.equal(r.body.text[0], goal);
  } finally { await cleanup(root); }
});

test('read_epic without includePlan emits goal + logbook only (no plan block)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'reads', title: 'R', goal: 'G' } });
    await mcp.handle({ tool: 'log_epic', arguments: { project: 'demo', slug: 'reads', entry: 'landed' } });
    const r = await mcp.handle({ tool: 'read_epic', arguments: { project: 'demo', slug: 'reads' } });
    assert.equal(r.body.text.length, 2);
    assert.equal(r.body.text[0], 'G');
    assert.match(r.body.text[1], /landed/);
  } finally { await cleanup(root); }
});

// M2 — log_epic is a MUTATOR, so it stays on the plain {result} contract. Kills
// a mutant that adds it to RAW_TEXT (which would emit {meta,text} and leave every
// `body.result.ok` reader with undefined).
test('log_epic dispatches as a mutator, on the plain {result} envelope', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'auth', title: 'A' } });
    const r = await mcp.handle({ tool: 'log_epic', arguments: { project: 'demo', slug: 'auth', entry: 'resequenced 0004 before 0003' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.ok, true);
    assert.equal(r.body.text, undefined);
    assert.equal(r.body.meta, undefined);
    // ...and the entry really landed on the epic.
    const e = await mcp.handle({ tool: 'read_epic', arguments: { project: 'demo', slug: 'auth' } });
    assert.match(e.body.text[0] ?? e.body.text[1], /resequenced 0004 before 0003/);
  } finally { await cleanup(root); }
});

// M3 — the old union name is really gone. An unknown tool is a loud,
// self-describing 200 {error}; this kills a back-compat alias quietly re-added
// to `handlers`, which would keep log_progress alive in habit and transcripts.
test('log_progress is no longer a tool — no back-compat alias', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await mcp.handle({ tool: 'log_progress', arguments: { project: 'demo', entry: 'x' }, caller: { sessionId: 's' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.error, 'unknown tool: log_progress');
    assert.equal(r.body.result, undefined);
  } finally { await cleanup(root); }
});

// T-new-1 (card 2026-0028) — the manifest's advertised tool-name set and
// src/mcp.js's dispatchable set are the SAME set. A rename that lands on one
// side only is silent in both directions: an advertised-but-undispatchable name
// is a tool the conductor calls and gets `unknown tool` for, and a
// dispatchable-but-unadvertised name is a live surface nothing documents. The
// two sets are read from the two real sources, so neither can be satisfied by a
// hardcoded list here.
test('every advertised tool is dispatchable and every dispatchable tool is advertised', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'conductor.plugin.json'), 'utf8'),
  );
  const advertised = manifest.mcp.tools.map((t) => t.name).sort();
  const dispatchable = mcp._toolNames().sort();
  assert.deepEqual(dispatchable, advertised);
});

// T-new-2 (card 2026-0028) — the seven pre-rename tool names are really gone,
// extending M3's guard to the task -> card rename. No back-compat aliases: a
// stale registry LACKS the new names, so an alias would preserve the dead path
// without opening the live one. Each must be a loud, self-describing 200
// {error}, never a silent success.
test('the pre-rename task_* tool names are gone — no back-compat aliases', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    for (const dead of ['file_task', 'list_tasks', 'read_task', 'move_task', 'update_task', 'delete_task', 'read_progress']) {
      const r = await mcp.handle({ tool: dead, arguments: { project: 'demo', id: '2026-0001', title: 't' }, caller: { sessionId: 's' } });
      assert.equal(r.status, 200, dead);
      assert.equal(r.body.error, `unknown tool: ${dead}`, dead);
      assert.equal(r.body.result, undefined, dead);
    }
  } finally { await cleanup(root); }
});

// M4 — logbook_total is a scalar, so the split rule keeps it in the METADATA
// block while the tail'd entries ride the text block. Kills both a mutant that
// promotes it into a text block and one that computes it after the slice.
test('read_epic keeps logbook_total in the metadata block, at full length', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'auth', title: 'A' } });
    for (const e of ['a', 'b', 'c', 'd', 'e']) {
      await mcp.handle({ tool: 'log_epic', arguments: { project: 'demo', slug: 'auth', entry: e } });
    }
    const r = await mcp.handle({ tool: 'read_epic', arguments: { project: 'demo', slug: 'auth', logTail: 2 } });
    assert.equal(r.body.meta.logbook_total, 5);
    const logbook = r.body.text[r.body.text.length - 1];
    assert.equal(logbook.split('\n').length, 2, 'only the tail rides the text block');
    assert.match(logbook, /· d$/m);
    assert.match(logbook, /· e$/m);
  } finally { await cleanup(root); }
});

test('create_epic via mcp: an absolute plan is ingested and the stored link reported', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kanban-src-'));
  try {
    const source = path.join(dir, 'wake-plan.md');
    fs.writeFileSync(source, '# the epic strategy');
    const c = await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'auth', title: 'A', plan: source } });
    assert.equal(c.body.result.plan, 'board:epic-auth.md');
    assert.equal(fs.readFileSync(path.join(plansDir('demo'), 'epic-auth.md'), 'utf8'), '# the epic strategy');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await cleanup(root); }
});
