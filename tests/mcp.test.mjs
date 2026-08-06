import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

    const re = await mcp.handle({ tool: 'read_epic', arguments: { slug: 'platform' } });
    assert.equal(re.body.result.ok, true);
    assert.deepEqual(re.body.result.epic.projects, ['web', 'api']);
    assert.equal(re.body.result.tasks.length, 1);

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
    const log = await mcp.handle({ tool: 'read_progress', arguments: { project: 'demo', id } });
    assert.match(log.body.result.entries[0], /via-mcp/);
  } finally { await cleanup(root); }
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
    assert.equal(r.body.result.task.commit, 'abc123');
  } finally { await cleanup(root); }
});

test('read_task includePlan returns the plan body as a RAW text block, metadata in {meta}', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'planned' } });
    const id = f.body.result.id;
    const file = path.join(plansDir('demo'), 'p.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# plan\n\nmulti-line prose\n');
    await mcp.handle({ tool: 'update_task', arguments: { project: 'demo', id, fields: { plan: 'p.md' } } });

    const r = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id, includePlan: true } });
    // The body rides the host's raw-text channel ({meta,text}), NOT {result} —
    // so it is never JSON-escaped into one line.
    assert.equal(r.body.result, undefined);
    assert.equal(r.body.text, '# plan\n\nmulti-line prose\n');
    assert.equal(r.body.meta.ok, true);
    assert.equal('plan_body' in r.body.meta, false);
    assert.equal(r.body.meta.plan_path, file);
    assert.equal(r.body.meta.plan_truncated, false);
    assert.equal(r.body.meta.plan_missing, false);
    assert.equal(r.body.meta.task.plan, 'board:p.md');
  } finally { await cleanup(root); }
});

test('read_task without a readable plan body stays on the plain {result} path', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'unplanned' } });
    const id = f.body.result.id;
    const plain = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id } });
    assert.equal(plain.body.result.ok, true);
    assert.equal(plain.body.text, undefined);
    // includePlan on a card with no link: plan_body is null (not a string), so
    // there is no raw block to emit.
    const asked = await mcp.handle({ tool: 'read_task', arguments: { project: 'demo', id, includePlan: true } });
    assert.equal(asked.body.text, undefined);
    assert.equal(asked.body.result.plan_body, null);
    assert.equal(asked.body.result.plan_missing, false);
  } finally { await cleanup(root); }
});
