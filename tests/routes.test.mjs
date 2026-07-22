import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshRoot, cleanup } from './_helpers.mjs';
import { _setProjectFetcher } from '../src/projects.js';
import { createServer } from '../server.js';

// Drive the web GUI's HTTP routes end-to-end through the Express app (the same
// path the browser uses), asserting the {ok} envelope contract: domain
// refusals are 200 {ok:false,code,reason}; only malformed JSON is 400 {error}.

function useProjects(names) { _setProjectFetcher(async () => names); }

async function boot() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const json = async (path, opts = {}) => {
    const res = await fetch(base + path, {
      headers: { 'content-type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, json, close: () => new Promise((r) => server.close(r)) };
}

async function withServer(fn) {
  const root = await freshRoot();
  useProjects(['demo']);
  const srv = await boot();
  try {
    await fn(srv);
  } finally {
    await srv.close();
    await cleanup(root);
  }
}

test('GET /api/projects returns the catalog', async () => {
  await withServer(async ({ json }) => {
    const { status, body } = await json('/api/projects');
    assert.equal(status, 200);
    assert.deepEqual(body, { projects: ['demo'] });
  });
});

test('GET /api/board/meta returns states + transitions from the single source', async () => {
  await withServer(async ({ json }) => {
    const { status, body } = await json('/api/board/meta');
    assert.equal(status, 200);
    assert.deepEqual(body.states, ['triage', 'backlog', 'todo', 'in-progress', 'done']);
    assert.ok(body.transitions.includes('triage>backlog'));
    assert.ok(body.transitions.includes('in-progress>done'));
    assert.ok(!body.transitions.includes('triage>done'));
  });
});

test('file -> list -> read round-trip through the routes', async () => {
  await withServer(async ({ json }) => {
    const filed = await json('/api/board/demo/tasks', { method: 'POST', body: { title: 't1', goal: 'g', acceptance: ['a', 'b'], epic: undefined } });
    assert.equal(filed.status, 200);
    assert.equal(filed.body.ok, true);
    const id = filed.body.id;

    const listed = await json('/api/board/demo/tasks');
    assert.equal(listed.body.ok, true);
    assert.equal(listed.body.tasks.length, 1);
    assert.equal(listed.body.tasks[0].id, id);
    assert.equal(listed.body.tasks[0].state, 'triage');

    const read = await json(`/api/board/demo/tasks/${id}`);
    assert.equal(read.body.ok, true);
    assert.equal(read.body.task.title, 't1');
    assert.deepEqual(read.body.task.acceptance, [{ text: 'a', done: false }, { text: 'b', done: false }]);
    assert.ok(read.body.task.logbook.length >= 1);
  });
});

test('legal move returns {ok:true,from,to}; illegal move returns 200 INVALID_STATE', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'm' } })).body.id;

    const legal = await json(`/api/board/demo/tasks/${id}/move`, { method: 'POST', body: { to: 'backlog' } });
    assert.equal(legal.status, 200);
    assert.deepEqual(legal.body, { ok: true, from: 'triage', to: 'backlog' });

    // triage -> done is not in ALLOWED_TRANSITIONS; the refusal is a normal 200.
    const id2 = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'm2' } })).body.id;
    const illegal = await json(`/api/board/demo/tasks/${id2}/move`, { method: 'POST', body: { to: 'done' } });
    assert.equal(illegal.status, 200);
    assert.equal(illegal.body.ok, false);
    assert.equal(illegal.body.code, 'INVALID_STATE');
    assert.match(illegal.body.reason, /illegal transition triage -> done/);
  });
});

test('move to a non-in-progress destination clears owner (no stuck gui owner)', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'o' } })).body.id;
    // triage -> backlog (not in-progress): owner must not be set even though the
    // route passes GUI_ACTOR.
    await json(`/api/board/demo/tasks/${id}/move`, { method: 'POST', body: { to: 'backlog' } });
    const read = await json(`/api/board/demo/tasks/${id}`);
    assert.equal(read.body.task.owner, null);
  });
});

test('PATCH updates whitelisted fields; acceptance is not editable', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'u', acceptance: ['x'] } })).body.id;
    const patched = await json(`/api/board/demo/tasks/${id}`, { method: 'PATCH', body: { title: 'u2', priority: 5, acceptance: [{ text: 'y', done: true }] } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.ok, true);
    const read = await json(`/api/board/demo/tasks/${id}`);
    assert.equal(read.body.task.title, 'u2');
    assert.equal(read.body.task.priority, 5);
    // acceptance patch ignored — still the filed value.
    assert.deepEqual(read.body.task.acceptance, [{ text: 'x', done: false }]);
  });
});

test('epics: create (upsert) -> list -> read with rollup', async () => {
  await withServer(async ({ json }) => {
    const created = await json('/api/board/demo/epics', { method: 'POST', body: { slug: 'auth', title: 'Auth', goal: 'login' } });
    assert.equal(created.body.ok, true);
    // Re-create refreshes title/goal, preserves created (upsert).
    const reread0 = (await json('/api/board/demo/epics/auth')).body.epic.created;
    await json('/api/board/demo/epics', { method: 'POST', body: { slug: 'auth', title: 'Auth v2', goal: 'login2' } });
    const reread = (await json('/api/board/demo/epics/auth')).body;
    assert.equal(reread.epic.title, 'Auth v2');
    assert.equal(reread.epic.created, reread0);

    // File a task under the epic and confirm the rollup counts it.
    await json('/api/board/demo/tasks', { method: 'POST', body: { title: 't', epic: 'auth' } });
    const listed = await json('/api/board/demo/epics');
    const auth = listed.body.epics.find((e) => e.slug === 'auth');
    assert.equal(auth.rollup.triage, 1);

    const read = await json('/api/board/demo/epics/auth');
    assert.equal(read.body.ok, true);
    assert.equal(read.body.tasks.length, 1);
  });
});

test('unknown project -> 200 PROJECT_UNKNOWN (not a transport error)', async () => {
  await withServer(async ({ json }) => {
    const { status, body } = await json('/api/board/ghost/tasks');
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'PROJECT_UNKNOWN');
  });
});

test('malformed JSON body -> 400 {error}', async () => {
  await withServer(async ({ json, server }) => {
    // Bypass the json() helper to send raw bad JSON.
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/board/demo/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid request body');
  });
});

test('unknown epic on file_task -> 200 EPIC_UNKNOWN', async () => {
  await withServer(async ({ json }) => {
    const { status, body } = await json('/api/board/demo/tasks', { method: 'POST', body: { title: 't', epic: 'nope' } });
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'EPIC_UNKNOWN');
  });
});

test('unexpected throw in a board fn -> 500 {error}, not a hung response', async () => {
  await withServer(async ({ json }) => {
    // Force the project fetcher (and thus validateProject inside board.js) to
    // throw — an unexpected exception, not a domain refusal. Express 4 does NOT
    // forward a rejected async handler to the error middleware, so without the
    // route wrapper this would leave the response unwritten and the request
    // would hang (the json() helper would await res.json() until the test
    // timeout). The wrapper turns the throw into 500 {error}.
    _setProjectFetcher(async () => { throw new Error('boom'); });
    const { status, body } = await json('/api/board/demo/tasks');
    assert.equal(status, 500);
    assert.equal(body.error, 'boom');
  });
});