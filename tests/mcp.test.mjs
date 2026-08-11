import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    const res = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 't' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.ok, true);
    assert.ok(res.body.result.id);
  } finally { await cleanup(root); }
});

test('domain refusal rides in {result:{ok:false}}, not {error}', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const res = await mcp.handle({ tool: 'list_tasks', arguments: { project: 'ghost' } });
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
    await mcp.handle({ tool: 'file_task', arguments: { project: 'api', title: 't', epic: 'platform' } });

    // read_epic rides the raw-text channel ({meta,text}) — see the read_epic
    // tests below; the epic/tasks metadata it asserts here lives in `meta`.
    const re = await mcp.handle({ tool: 'read_epic', arguments: { slug: 'platform' } });
    assert.equal(re.body.meta.ok, true);
    assert.deepEqual(re.body.meta.epic.projects, ['web', 'api']);
    assert.equal(re.body.meta.tasks.length, 1);

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
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'o' } });
    const id = f.body.result.id;
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'todo' } });
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'in-progress', owner: 'sid-123' } });

    // log_progress takes no id; the card is resolved from caller.sessionId.
    const res = await mcp.handle(
      { tool: 'log_progress', arguments: { project: 'demo', entry: 'via-mcp' }, caller: { sessionId: 'sid-123' } },
    );
    assert.equal(res.body.result.ok, true);
    // read_progress' entries ride the raw-text channel, not {result.entries}.
    const log = await mcp.handle({ tool: 'read_progress', arguments: { project: 'demo', id } });
    assert.match(log.body.text[0], /via-mcp/);
  } finally { await cleanup(root); }
});

// file_task's dispatch spreads `...a`, so a new argument needs no mcp.js edit —
// this pins that the `plan` param actually survives the spread and that the
// result (incl. the new `plan` key) rides the plain {result} envelope.
test('file_task via mcp: an absolute plan is ingested and reported in {result}', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kanban-src-'));
  try {
    const source = path.join(srcDir, 'wake.md');
    fs.writeFileSync(source, '# plan from the wake\n');
    const res = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 't', plan: source } });
    assert.equal(res.status, 200);
    assert.equal(res.body.error, undefined);
    const { ok, id, plan } = res.body.result;
    assert.equal(ok, true);
    assert.ok(id);
    assert.equal(plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(path.join(plansDir('demo'), `${id}.md`), 'utf8'), '# plan from the wake\n');
  } finally { fs.rmSync(srcDir, { recursive: true, force: true }); await cleanup(root); }
});

test('delete_task via mcp: happy path removes the card, unknown id rides in {result:{ok:false}}', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 't' } });
    const id = f.body.result.id;

    const del = await mcp.handle({ tool: 'delete_task', arguments: { project: 'demo', id } });
    assert.equal(del.body.result.ok, true);

    const missing = await mcp.handle({ tool: 'delete_task', arguments: { project: 'demo', id } });
    assert.equal(missing.body.error, undefined);
    assert.equal(missing.body.result.ok, false);
    assert.equal(missing.body.result.code, 'TASK_UNKNOWN');
  } finally { await cleanup(root); }
});

test('move_task forwards an explicit commit arg through to the stamped task', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 't' } });
    const id = f.body.result.id;
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'todo' } });
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'in-progress', owner: 'w' } });
    const mv = await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'done', commit: 'abc123' } });
    assert.equal(mv.body.result.ok, true);

    const r = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id } });
    assert.equal(r.body.meta.task.commit, 'abc123');
  } finally { await cleanup(root); }
});

test('read_task includePlan: card body then plan body, two RAW blocks in that order', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'planned', goal: 'ship it' } });
    const id = f.body.result.id;
    const file = path.join(plansDir('demo'), 'p.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# plan\n\nmulti-line prose\n');
    await mcp.handle({ tool: 'update_task', arguments: { project: 'demo', id, fields: { plan: 'p.md' } } });

    const r = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id, includePlan: true } });
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
    assert.equal(r.body.meta.task.plan, 'board:p.md');
  } finally { await cleanup(root); }
});

// Rewritten under 2026-0010: read_task now ALWAYS takes the {meta,text} path
// (the card body is unconditional), so there is no {result} fallback left to
// pin — what this pins instead is that a card with no readable plan gets
// exactly ONE block, the card body.
test('read_task without a readable plan body emits the card body alone (one block)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'unplanned' } });
    const id = f.body.result.id;
    const plain = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id } });
    assert.equal(plain.body.result, undefined);
    assert.equal(plain.body.meta.ok, true);
    assert.equal(plain.body.text.length, 1);
    // includePlan on a card with no link: plan_body is null (not a string), so
    // there is no second raw block — and no plan_body key on meta either.
    const asked = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id, includePlan: true } });
    assert.equal(asked.body.text.length, 1);
    assert.equal(asked.body.meta.plan_body, null);
    assert.equal(asked.body.meta.plan_missing, false);
  } finally { await cleanup(root); }
});

// Three distinct `plan_body` outcomes, and what each leaves in meta. The empty
// case is the subtle one: '' IS a string, so it is promoted off meta, but an
// empty body emits no block — so meta ends up with no `plan_body` key and
// plan_missing:false. Pinned deliberately; see docs/protocol.md.
test('read_task plan_body: read vs empty file vs no link, and the meta signal for each', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const mk = async (title, contents) => {
      const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title } });
      const id = f.body.result.id;
      if (contents !== null) {
        const file = path.join(plansDir('demo'), `${title}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
        await mcp.handle({ tool: 'update_task', arguments: { project: 'demo', id, fields: { plan: `${title}.md` } } });
      }
      return mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id, includePlan: true } });
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

test('read_task card body is real markdown; the JSON block keeps only branchable scalars', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const goal = 'Make it read well.\n\nSecond paragraph with `- [ ]` looking text.';
    const f = await mcp.handle({
      tool: 'file_task',
      arguments: { project: 'demo', title: 'prose', goal, acceptance: ['first crit', 'second crit'] },
    });
    const id = f.body.result.id;
    const r = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id } });

    assert.equal(r.body.result, undefined);
    assert.equal(r.body.text.length, 1);
    const body = r.body.text[0];
    assert.match(body, /^## Goal\n/);
    assert.ok(body.includes(goal));              // prose verbatim, not escaped
    assert.ok(body.includes('- [ ] first crit')); // real checkboxes
    assert.ok(body.includes('- [ ] second crit'));
    assert.match(body, /## Logbook\n- .*filed/);
    // The three body sections left the JSON block…
    assert.equal('goal' in r.body.meta.task, false);
    assert.equal('acceptance' in r.body.meta.task, false);
    assert.equal('logbook' in r.body.meta.task, false);
    // …and every branchable scalar stayed (task stays nested and complete).
    assert.equal(r.body.meta.task.id, id);
    assert.equal(r.body.meta.task.title, 'prose');
    assert.equal(r.body.meta.task.state, 'triage');
    assert.ok(r.body.meta.task.updated);
    assert.equal(r.body.meta.plan_path, null);
  } finally { await cleanup(root); }
});

test('read_task logTail is honoured in the card-body text block', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'logged' } });
    const id = f.body.result.id;
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'todo' } });
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'in-progress', owner: 'w' } });

    const all = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id } });
    const logLines = (t) => t.split('## Logbook\n')[1].split('\n').filter((l) => l.startsWith('- '));
    assert.equal(logLines(all.body.text[0]).length, 3);

    // The body is RENDERED from the (sliced) task object, never read off disk —
    // the file still holds all three entries.
    const tail = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id, logTail: 1 } });
    const tailed = logLines(tail.body.text[0]);
    assert.equal(tailed.length, 1);
    assert.match(tailed[0], /in-progress/);
  } finally { await cleanup(root); }
});

test('read_progress: entries become a bulleted text block, meta keeps total + count', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'p' } });
    const id = f.body.result.id;
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'todo' } });
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'in-progress', owner: 'w' } });
    await mcp.handle({ tool: 'log_progress', arguments: { project: 'demo', id, entry: 'third' } });

    const all = await mcp.handle({ tool: 'read_progress', arguments: { project: 'demo', id } });
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
    const some = await mcp.handle({ tool: 'read_progress', arguments: { project: 'demo', id, limit: 2 } });
    assert.equal(some.body.meta.total, 4);
    assert.equal(some.body.meta.count, 2);
    assert.equal(some.body.text[0].split('\n').length, 2);
  } finally { await cleanup(root); }
});

test('read_progress with zero entries: metadata block only, no empty text block', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'p' } });
    const id = f.body.result.id;
    const res = await mcp.handle({ tool: 'read_progress', arguments: { project: 'demo', id, limit: 0 } });
    assert.equal(res.body.text.length, 0);
    assert.equal(res.body.meta.count, 0);
    assert.equal(res.body.meta.total, 1);
  } finally { await cleanup(root); }
});

test('read_epic: goal prose becomes the text block, tasks stay a JSON array', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const goal = 'Unify the reads.\n\nWhy: LLMs read markdown.';
    await mcp.handle({ tool: 'create_epic', arguments: { project: 'demo', slug: 'reads', title: 'Reads', goal } });
    await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 't', epic: 'reads' } });

    const r = await mcp.handle({ tool: 'read_epic', arguments: { project: 'demo', slug: 'reads' } });
    assert.equal(r.body.result, undefined);
    assert.equal(r.body.text.length, 1);
    assert.equal(r.body.text[0], goal);
    assert.equal('goal' in r.body.meta.epic, false);
    assert.equal(r.body.meta.epic.slug, 'reads');
    assert.equal(r.body.meta.epic.title, 'Reads');
    assert.ok(r.body.meta.epic.rollup);
    assert.equal(Array.isArray(r.body.meta.tasks), true);
    assert.equal(r.body.meta.tasks[0].title, 't');
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

test('list_tasks stays pure JSON — a table of summaries is data, not prose', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'a', goal: 'some prose' } });
    const r = await mcp.handle({ tool: 'list_tasks', arguments: { project: 'demo' } });
    assert.equal(Array.isArray(r.body.result.tasks), true);
    assert.equal(r.body.text, undefined);
    assert.equal(r.body.meta, undefined);
  } finally { await cleanup(root); }
});

// EVERY raw-text tool, not just read_task: shapeBody's `ok === true` guard is
// what keeps a refusal in {result}. Without it the {ok:false,code} object moves
// into `meta` with no `result` key, breaking any consumer branching on
// `body.result.code`.
test('a refusal on any raw-text tool keeps the plain {result} path', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const cases = [
      ['read_task', { project: 'demo', id: 'nope' }, 'TASK_UNKNOWN'],
      ['read_progress', { project: 'demo', id: 'nope' }, 'TASK_UNKNOWN'],
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
