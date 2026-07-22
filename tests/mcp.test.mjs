import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshRoot, cleanup } from './_helpers.mjs';
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

test('caller.sessionId is threaded into owner-scoped tools', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await mcp.handle({ tool: 'file_task', arguments: { project: 'demo', title: 'o' } });
    const id = f.body.result.id;
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'todo' } });
    await mcp.handle({ tool: 'move_task', arguments: { project: 'demo', id, to: 'in-progress', owner: 'sid-123' } });

    // append_log takes no id; the card is resolved from caller.sessionId.
    const res = await mcp.handle(
      { tool: 'append_log', arguments: { project: 'demo', entry: 'via-mcp' }, caller: { sessionId: 'sid-123' } },
    );
    assert.equal(res.body.result.ok, true);
    const log = await mcp.handle({ tool: 'read_log', arguments: { project: 'demo', id } });
    assert.match(log.body.result.entries[0], /via-mcp/);
  } finally { await cleanup(root); }
});
