import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshRoot, cleanup } from './_helpers.mjs';
import { plansDir } from '../src/paths.js';
import { _setProjectFetcher } from '../src/projects.js';
import * as board from '../src/board.js';
import { PRIORITIES } from '../src/priority.js';
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

test('move to done forwards an explicit commit through to the stamped task', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'c' } })).body.id;
    await json(`/api/board/demo/tasks/${id}/move`, { method: 'POST', body: { to: 'todo' } });
    await json(`/api/board/demo/tasks/${id}/move`, { method: 'POST', body: { to: 'in-progress' } });
    const moved = await json(`/api/board/demo/tasks/${id}/move`, { method: 'POST', body: { to: 'done', commit: 'cafe1234' } });
    assert.equal(moved.body.ok, true);

    const read = await json(`/api/board/demo/tasks/${id}`);
    assert.equal(read.body.task.commit, 'cafe1234');
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

test('PATCH updates whitelisted fields; acceptance edits via {replace}, but a bare array is refused', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'u', acceptance: ['x'] } })).body.id;
    const patched = await json(`/api/board/demo/tasks/${id}`, {
      method: 'PATCH', body: { title: 'u2', priority: 'HIGH', acceptance: { replace: ['y'] } },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.ok, true);
    const read = await json(`/api/board/demo/tasks/${id}`);
    assert.equal(read.body.task.title, 'u2');
    assert.equal(read.body.task.priority, 'HIGH');
    assert.deepEqual(read.body.task.acceptance, [{ text: 'y', done: false }]);

    // A bare array (the natural `string[]` guess, since that is file_task's
    // filing-time shape) was PREVIOUSLY silently ignored — this is the
    // deliberate 2026-0020 behaviour change: it now refuses INVALID_STATE, and
    // the reason names all three accepted shapes.
    const bad = await json(`/api/board/demo/tasks/${id}`, {
      method: 'PATCH', body: { title: 'u3', acceptance: [{ text: 'z', done: true }] },
    });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.code, 'INVALID_STATE');
    assert.equal(bad.body.reason, 'acceptance must be {ops:[…]}, {replace:[…]}, or null');
    const unchanged = await json(`/api/board/demo/tasks/${id}`);
    assert.equal(unchanged.body.task.title, 'u2'); // the accompanying title change did NOT land either
    assert.deepEqual(unchanged.body.task.acceptance, [{ text: 'y', done: false }]);
  });
});

test('the GUI textarea round-trip keeps ticks: {op:done} then {replace} with the exact textarea payload', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'u', acceptance: ['a', 'b'] } })).body.id;
    await json(`/api/board/demo/tasks/${id}`, {
      method: 'PATCH', body: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } },
    });
    // What the edit form's textarea actually sends: one line per criterion.
    const patched = await json(`/api/board/demo/tasks/${id}`, {
      method: 'PATCH', body: { acceptance: { replace: ['a', 'b', 'c'] } },
    });
    assert.equal(patched.body.ok, true);
    const read = await json(`/api/board/demo/tasks/${id}`);
    assert.deepEqual(read.body.task.acceptance, [
      { text: 'a', done: true }, { text: 'b', done: false }, { text: 'c', done: false },
    ]);
  });
});

test('PATCH {acceptance:null} clears the list over HTTP', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'u', acceptance: ['a', 'b'] } })).body.id;
    const patched = await json(`/api/board/demo/tasks/${id}`, { method: 'PATCH', body: { acceptance: null } });
    assert.equal(patched.body.ok, true);
    const read = await json(`/api/board/demo/tasks/${id}`);
    assert.deepEqual(read.body.task.acceptance, []);
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

test('cross-project epics: POST /api/epics -> GET /api/epics/:slug -> appears in member list', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api']);
  const srv = await boot();
  try {
    const created = await srv.json('/api/epics', { method: 'POST', body: { slug: 'platform', title: 'Platform', goal: 'shared', projects: ['web', 'api'] } });
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);

    // File under it in both members.
    await srv.json('/api/board/web/tasks', { method: 'POST', body: { title: 'w', epic: 'platform' } });
    await srv.json('/api/board/api/tasks', { method: 'POST', body: { title: 'a', epic: 'platform' } });

    // Direct read by slug aggregates across members.
    const read = await srv.json('/api/epics/platform');
    assert.equal(read.body.ok, true);
    assert.deepEqual(read.body.epic.projects, ['web', 'api']);
    assert.equal(read.body.epic.rollup.triage, 2);
    assert.equal(read.body.tasks.length, 2);

    // It also shows up in a member project's epic list, flagged with projects.
    const list = await srv.json('/api/board/web/epics');
    const pe = list.body.epics.find((e) => e.slug === 'platform');
    assert.deepEqual(pe.projects, ['web', 'api']);
    assert.equal(pe.rollup.triage, 2);

    // Slug conflict surfaces as a normal 200 refusal.
    await srv.json('/api/board/web/epics', { method: 'POST', body: { slug: 'local', title: 'Local' } });
    const clash = await srv.json('/api/epics', { method: 'POST', body: { slug: 'local', title: 'X', projects: ['web', 'api'] } });
    assert.equal(clash.status, 200);
    assert.equal(clash.body.code, 'EPIC_CONFLICT');
  } finally {
    await srv.close();
    await cleanup(root);
  }
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

test('GET /api/sync/export returns the full card set incl. the hidden uid stamp', async () => {
  await withServer(async ({ json }) => {
    await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'Exportable' } });
    const { status, body } = await json('/api/sync/export?scope=project&project=demo');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.projects.demo));
    const [c] = body.projects.demo;
    assert.equal(c.title, 'Exportable');
    assert.ok(c.uid); // export is the one place uid is exposed
    assert.ok(c.updated);
  });
});

test('GET /api/sync/export includes project + cross epics with the hidden stamp', async () => {
  await withServer(async ({ json }) => {
    await json('/api/board/demo/epics', { method: 'POST', body: { slug: 'auth', title: 'Auth' } });
    const { status, body } = await json('/api/sync/export?scope=project&project=demo');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.projectEpics.demo));
    assert.ok(Array.isArray(body.crossEpics));
    const auth = body.projectEpics.demo.find((e) => e.slug === 'auth');
    assert.equal(auth.title, 'Auth');
    assert.ok(auth.updated && auth.node); // export exposes the epic stamp
  });
});

test('POST /api/sync/pull merges a stubbed peer dump and returns a summary', async () => {
  await withServer(async ({ json }) => {
    board._setSyncFetcher(async () => ({
      ok: true, nodeId: 'peer', projects: { demo: [{
        id: '2026-0001', uid: 'u-peer', title: 'FromPeer', project: 'demo',
        epic: null, priority: 0, created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z', node: 'peer', owner: null,
        commit: null, depends_on: [], goal: '', acceptance: [], logbook: [],
        state: 'triage',
      }] },
    }));
    try {
      const { status, body } = await json('/api/sync/pull', {
        method: 'POST', body: { peerUrl: 'http://peer.test', scope: 'project', project: 'demo' },
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.summary.added, 1);
      const read = await json('/api/board/demo/tasks/2026-0001');
      assert.equal(read.body.task.title, 'FromPeer');
    } finally {
      board._setSyncFetcher(null);
    }
  });
});

test('POST /api/sync/pull with a bad peerUrl -> 200 {ok:false, INVALID_STATE}', async () => {
  await withServer(async ({ json }) => {
    const { status, body } = await json('/api/sync/pull', {
      method: 'POST', body: { peerUrl: 'nope', scope: 'project', project: 'demo' },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'INVALID_STATE');
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
test('GET /tasks/:id?includePlan=1 returns plan_path + plan_body; without it, only plan_path', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'planned' } })).body.id;
    const file = path.join(plansDir('demo'), 'p.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# plan body\nsecond line\n');
    const patched = await json(`/api/board/demo/tasks/${id}`, { method: 'PATCH', body: { plan: 'p.md' } });
    assert.equal(patched.body.ok, true);

    const plain = await json(`/api/board/demo/tasks/${id}`);
    assert.equal(plain.body.task.plan, 'board:p.md');
    assert.equal(plain.body.plan_path, file);
    assert.equal('plan_body' in plain.body, false); // no body unless asked

    const withPlan = await json(`/api/board/demo/tasks/${id}?includePlan=1`);
    assert.equal(withPlan.body.plan_body, '# plan body\nsecond line\n');
    assert.equal(withPlan.body.plan_missing, false);
    assert.equal((await json(`/api/board/demo/tasks/${id}?includePlan=true`)).body.plan_body, '# plan body\nsecond line\n');
    // Any other value is falsy — the route coerces, it doesn't guess.
    assert.equal('plan_body' in (await json(`/api/board/demo/tasks/${id}?includePlan=0`)).body, false);
  });
});

test('PATCH with an unresolvable plan field returns 200 PLAN_UNKNOWN', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 't' } })).body.id;
    const res = await json(`/api/board/demo/tasks/${id}`, { method: 'PATCH', body: { plan: 'ghost.md' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'PLAN_UNKNOWN');
  });
});

// The ingest lives in board.js, NOT at a surface — so the GUI's PATCH seam gets
// it for free (routes.js passes req.body through as `fields`, zero edits).
test('PATCH with an ABSOLUTE plan path ingests the file and returns the board: link', async () => {
  await withServer(async ({ json }) => {
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'planned' } })).body.id;
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kanban-src-'));
    try {
      const source = path.join(srcDir, 'host-plan.md');
      fs.writeFileSync(source, '# ingested over HTTP\n');
      const res = await json(`/api/board/demo/tasks/${id}`, { method: 'PATCH', body: { plan: source } });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.plan, `board:${id}.md`);
      assert.equal(fs.readFileSync(path.join(plansDir('demo'), `${id}.md`), 'utf8'), '# ingested over HTTP\n');
      const read = await json(`/api/board/demo/tasks/${id}?includePlan=1`);
      assert.equal(read.body.task.plan, `board:${id}.md`);
      assert.equal(read.body.plan_body, '# ingested over HTTP\n');
    } finally { fs.rmSync(srcDir, { recursive: true, force: true }); }
  });
});

// ---- priority over HTTP ---------------------------------------------------

test('GET /api/board/meta advertises the priority levels in rank order', async () => {
  await withServer(async ({ json }) => {
    const { body } = await json('/api/board/meta');
    // The GUI renders its priority selects from this, so it must match the
    // server's catalog exactly — including order (highest first).
    assert.deepEqual(body.priorities, PRIORITIES);
    assert.deepEqual(body.priorities, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  });
});

test('POST /api/board/:project/tasks captures priority at filing time', async () => {
  await withServer(async ({ json }) => {
    const filed = await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'urgent thing', priority: 'CRITICAL' } });
    assert.equal(filed.body.ok, true);
    const read = await json(`/api/board/demo/tasks/${filed.body.id}`);
    assert.equal(read.body.task.priority, 'CRITICAL');

    // Omitted -> unset (the GUI's New-task select opens on the unset option too,
    // so the two filing surfaces agree).
    const bare = await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'ordinary thing' } });
    const bareRead = await json(`/api/board/demo/tasks/${bare.body.id}`);
    assert.equal(bareRead.body.task.priority, null);
    assert.notEqual(bareRead.body.task.priority, 'MEDIUM');
  });
});

test('PATCH with priority:null clears the level over HTTP', async () => {
  await withServer(async ({ json }) => {
    // The GUI's edit form submits its '— unset —' option as null; this is that
    // wire path end to end, JSON null included (which survives serialization
    // where `undefined` would not).
    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'z', priority: 'HIGH' } })).body.id;
    const patched = await json(`/api/board/demo/tasks/${id}`, { method: 'PATCH', body: { priority: null } });
    assert.equal(patched.body.ok, true, JSON.stringify(patched.body));
    assert.equal((await json(`/api/board/demo/tasks/${id}`)).body.task.priority, null);
  });
});

test('a bad priority is a 200 domain refusal, not a transport error', async () => {
  await withServer(async ({ json }) => {
    const filed = await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'x', priority: 'URGENT' } });
    assert.equal(filed.status, 200);
    assert.equal(filed.body.ok, false);
    assert.equal(filed.body.code, 'INVALID_STATE');

    const id = (await json('/api/board/demo/tasks', { method: 'POST', body: { title: 'y', priority: 'LOW' } })).body.id;
    const patched = await json(`/api/board/demo/tasks/${id}`, { method: 'PATCH', body: { priority: 3 } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.ok, false);
    assert.equal(patched.body.code, 'INVALID_STATE');
    assert.equal((await json(`/api/board/demo/tasks/${id}`)).body.task.priority, 'LOW');
  });
});
