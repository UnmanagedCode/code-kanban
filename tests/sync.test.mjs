import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshRoot, cleanup } from './_helpers.mjs';
import * as board from '../src/board.js';
import * as store from '../src/store.js';
import * as taskfile from '../src/taskfile.js';
import { _setProjectFetcher } from '../src/projects.js';
import { deriveUid } from '../src/nodeId.js';

// Cross-instance sync merge. Peer dumps are hand-crafted plain objects (the shape
// board.exportBoard returns) fed through the _setSyncFetcher seam — no network,
// no wall-clock dependence: version stamps are fixed ISO strings.

function useProjects(names) { _setProjectFetcher(async () => names); }

function card(o) {
  return {
    id: o.id, uid: o.uid, title: o.title ?? o.id, project: o.project ?? 'alpha',
    epic: o.epic ?? null, priority: o.priority ?? 0,
    created: o.created ?? '2026-01-01T00:00:00.000Z',
    updated: o.updated ?? o.created ?? '2026-01-01T00:00:00.000Z',
    node: o.node ?? 'peer-node', owner: o.owner ?? null, commit: o.commit ?? null,
    depends_on: o.depends_on ?? [], goal: o.goal ?? '', acceptance: o.acceptance ?? [],
    logbook: o.logbook ?? [], state: o.state ?? 'triage',
  };
}

function serveDump(projects) {
  board._setSyncFetcher(async () => ({ ok: true, nodeId: 'peer-node', projects }));
}

async function withRoot(fn) {
  const root = await freshRoot();
  useProjects(['alpha', 'beta']);
  try {
    await fn();
  } finally {
    board._setSyncFetcher(null);
    await cleanup(root);
  }
}

const pull = (scope, project) =>
  board.syncPull({ peerUrl: 'http://peer.test', scope, project });

// Find a stored card by title (full-card store read, so uid is visible).
function byTitle(project, title) {
  return store.exportTasks(project).find((c) => c.title === title);
}

test('taskfile round-trips uid/updated/node; absent -> null', () => {
  const t = {
    id: '2026-0001', uid: 'u-1', title: 'T', project: 'alpha', priority: 0,
    created: '2026-01-01T00:00:00.000Z', updated: '2026-02-02T00:00:00.000Z',
    node: 'n-1', depends_on: [], goal: '', acceptance: [], logbook: [],
  };
  const back = taskfile.parse(taskfile.serialize(t), { state: 'triage' });
  assert.equal(back.uid, 'u-1');
  assert.equal(back.updated, '2026-02-02T00:00:00.000Z');
  assert.equal(back.node, 'n-1');
  // A card serialized without the stamp parses the fields back as null.
  const legacy = taskfile.parse(taskfile.serialize({ ...t, uid: null, updated: null, node: null }), { state: 'triage' });
  assert.equal(legacy.uid, null);
  assert.equal(legacy.updated, null);
  assert.equal(legacy.node, null);
});

test('peer-only card with a free id is copied in, keeping its id', async () => {
  await withRoot(async () => {
    serveDump({ alpha: [card({ id: '2026-0001', uid: 'u-P', title: 'P1' })] });
    const r = await pull('project', 'alpha');
    assert.equal(r.ok, true);
    assert.equal(r.summary.added, 1);
    const got = await board.readTask({ project: 'alpha', id: '2026-0001' });
    assert.equal(got.task.title, 'P1');
  });
});

test('id collision with a different uid reassigns the incoming card', async () => {
  await withRoot(async () => {
    const filed = await board.fileTask({ project: 'alpha', title: 'Local' });
    assert.equal(filed.id, '2026-0001');
    serveDump({ alpha: [card({ id: '2026-0001', uid: 'u-P', title: 'Peer' })] });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.added, 1);
    assert.equal(r.summary.reassigned.length, 1);
    assert.equal(r.summary.reassigned[0].from, '2026-0001');
    assert.equal(r.summary.reassigned[0].to, '2026-0002');
    // Both cards present; local keeps 0001, peer lands at the reassigned slot.
    assert.equal(byTitle('alpha', 'Local').id, '2026-0001');
    assert.equal(byTitle('alpha', 'Peer').id, '2026-0002');
  });
});

test('same uid: newer peer version replaces the local card wholesale', async () => {
  await withRoot(async () => {
    await board.fileTask({ project: 'alpha', title: 'Local' });
    const uid = byTitle('alpha', 'Local').uid;
    serveDump({ alpha: [card({
      id: '2026-0001', uid, title: 'PeerWins', state: 'todo',
      updated: '2030-01-01T00:00:00.000Z',
    })] });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.updated, 1);
    assert.equal(r.summary.added, 0);
    const got = await board.readTask({ project: 'alpha', id: '2026-0001' });
    assert.equal(got.task.title, 'PeerWins');
    assert.equal(got.task.state, 'todo'); // moved to the winner's column
  });
});

test('same uid: older peer version loses, local untouched', async () => {
  await withRoot(async () => {
    await board.fileTask({ project: 'alpha', title: 'Local' });
    const uid = byTitle('alpha', 'Local').uid;
    serveDump({ alpha: [card({
      id: '2026-0001', uid, title: 'PeerOld', updated: '2000-01-01T00:00:00.000Z',
    })] });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.updated, 0);
    assert.equal(r.summary.added, 0);
    assert.equal(byTitle('alpha', 'Local').title, 'Local');
  });
});

test('equal updated -> higher node id wins deterministically', async () => {
  await withRoot(async () => {
    await board.fileTask({ project: 'alpha', title: 'Local' });
    const lc = byTitle('alpha', 'Local');
    // Higher node wins.
    serveDump({ alpha: [card({ id: '2026-0001', uid: lc.uid, title: 'HigherNode', updated: lc.updated, node: lc.node + '~' })] });
    let r = await pull('project', 'alpha');
    assert.equal(r.summary.updated, 1);
    assert.equal((await board.readTask({ project: 'alpha', id: '2026-0001' })).task.title, 'HigherNode');

    // Lower node loses (title stays HigherNode).
    const lc2 = byTitle('alpha', 'HigherNode');
    serveDump({ alpha: [card({ id: '2026-0001', uid: lc2.uid, title: 'LowerNode', updated: lc2.updated, node: '' })] });
    r = await pull('project', 'alpha');
    assert.equal(r.summary.updated, 0);
    assert.equal((await board.readTask({ project: 'alpha', id: '2026-0001' })).task.title, 'HigherNode');
  });
});

test('legacy cards (no uid) match by derived uid, no duplicate', async () => {
  await withRoot(async () => {
    // Write a true pre-feature card: no uid/updated/node in frontmatter.
    store.ensureProjectDirs('alpha');
    store.writeTask('alpha', 'triage', {
      id: '2026-0001', title: 'Legacy', project: 'alpha', priority: 0,
      created: '2026-01-01T00:00:00.000Z', depends_on: [], goal: '',
      acceptance: [], logbook: ['2026-01-01T00:00:00.000Z · conductor · filed'],
    });
    // The peer's export of the SAME legacy card carries the deterministic uid.
    const uid = deriveUid('alpha', '2026-0001', '2026-01-01T00:00:00.000Z');
    serveDump({ alpha: [card({
      id: '2026-0001', uid, title: 'Legacy', created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z', node: 'a',
    })] });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.added, 0); // matched by uid, not treated as new
    assert.equal(store.exportTasks('alpha').length, 1); // no duplicate
    assert.equal(byTitle('alpha', 'Legacy').uid, uid); // local backfilled the same uid
  });
});

test('all-projects scope: dependency remapped to a reassigned local id', async () => {
  await withRoot(async () => {
    await board.fileTask({ project: 'alpha', title: 'LocalX' }); // 2026-0001
    serveDump({
      alpha: [
        card({ id: '2026-0001', uid: 'u-A', title: 'DepTarget' }),
        card({ id: '2026-0002', uid: 'u-B', title: 'Dependent', depends_on: ['2026-0001'] }),
      ],
      beta: [],
    });
    const r = await pull('all');
    assert.equal(r.summary.added, 2);
    // A collided with LocalX's 0001 -> reassigned; B kept 0002.
    const target = byTitle('alpha', 'DepTarget');
    const dependent = byTitle('alpha', 'Dependent');
    assert.notEqual(target.id, '2026-0001');
    assert.deepEqual(dependent.depends_on, [target.id]); // remapped, not the raw remote id
    assert.equal(r.summary.droppedDeps.length, 0);
  });
});

test('single-project scope: unresolvable dependency is dropped and reported', async () => {
  await withRoot(async () => {
    serveDump({ alpha: [card({ id: '2026-0002', uid: 'u-B', title: 'Dangler', depends_on: ['2026-0009'] })] });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.added, 1);
    assert.equal(r.summary.droppedDeps.length, 1);
    assert.equal(r.summary.droppedDeps[0].dep, '2026-0009');
    assert.deepEqual(byTitle('alpha', 'Dangler').depends_on, []);
  });
});

test('readTask strips hidden uid/node; a merged card is readable', async () => {
  await withRoot(async () => {
    serveDump({ alpha: [card({ id: '2026-0001', uid: 'u-P', title: 'P1' })] });
    await pull('project', 'alpha');
    const got = await board.readTask({ project: 'alpha', id: '2026-0001' });
    assert.ok(!('uid' in got.task));
    assert.ok(!('node' in got.task));
    // Summary path also never carries uid/node.
    const listed = await board.listTasks({ project: 'alpha' });
    assert.ok(!('uid' in listed.tasks[0]));
    assert.ok(!('node' in listed.tasks[0]));
  });
});

test('peer projects absent locally are skipped and reported', async () => {
  await withRoot(async () => {
    serveDump({
      alpha: [card({ id: '2026-0001', uid: 'u-A', title: 'A' })],
      ghost: [card({ id: '2026-0001', uid: 'u-G', title: 'G', project: 'ghost' })],
    });
    const r = await pull('all');
    assert.equal(r.summary.added, 1); // only alpha merged
    assert.deepEqual(r.summary.skippedProjects, ['ghost']);
  });
});

test('bad peerUrl is refused before any fetch', async () => {
  await withRoot(async () => {
    const r = await board.syncPull({ peerUrl: 'not-a-url', scope: 'project', project: 'alpha' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_STATE');
  });
});
