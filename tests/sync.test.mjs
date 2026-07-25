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

// Write a card straight to the store with an explicit id/uid so collisions are
// STRUCTURAL (independent of new Date().getFullYear(), which mints local ids).
function seedLocal(project, o) {
  store.ensureProjectDirs(project);
  const c = card({ ...o, project });
  store.writeTask(project, c.state, c);
  return c;
}

const ID_RE = /^\d{4}-\d{4}$/;

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
    // Structural collision: local card written directly at 2026-0001.
    seedLocal('alpha', { id: '2026-0001', uid: 'u-L', title: 'Local' });
    serveDump({ alpha: [card({ id: '2026-0001', uid: 'u-P', title: 'Peer' })] });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.added, 1);
    assert.equal(r.summary.reassigned.length, 1);
    assert.equal(r.summary.reassigned[0].from, '2026-0001');
    const to = r.summary.reassigned[0].to;
    assert.match(to, ID_RE);
    assert.notEqual(to, '2026-0001');
    assert.ok(!('uid' in r.summary.reassigned[0])); // summary must not leak uid
    // Both cards present; local keeps 0001, peer lands at the reassigned slot.
    assert.equal(byTitle('alpha', 'Local').id, '2026-0001');
    assert.equal(byTitle('alpha', 'Peer').id, to);
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
    seedLocal('alpha', { id: '2026-0001', uid: 'u-L', title: 'LocalX' }); // structural collision
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
    assert.equal(r.summary.droppedDeps[0].card, '2026-0002'); // display id, not uid
    assert.ok(!('uid' in r.summary.droppedDeps[0]));
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

test('the whole pull summary carries no uid/node (nothing hidden leaks to the GUI)', async () => {
  await withRoot(async () => {
    // Exercise every summary field at once: a reassignment, a dropped dep, a
    // skipped project, a skipped malformed card.
    seedLocal('alpha', { id: '2026-0001', uid: 'u-L', title: 'Local' });
    serveDump({
      alpha: [
        card({ id: '2026-0001', uid: 'u-P', title: 'Collides' }),   // -> reassigned
        card({ id: '2026-0007', uid: 'u-D', title: 'Dangler', depends_on: ['2026-0099'] }), // -> dropped dep
        { id: '', uid: 'u-bad', title: 'NoId', state: 'triage' },   // -> skipped (bad id)
      ],
      ghost: [card({ id: '2026-0001', uid: 'u-G', title: 'G', project: 'ghost' })], // -> skipped project
    });
    const r = await pull('all');
    const blob = JSON.stringify(r.summary);
    // No card uid should appear anywhere in the response the GUI receives.
    for (const uid of ['u-L', 'u-P', 'u-D', 'u-bad', 'u-G']) {
      assert.ok(!blob.includes(uid), `summary leaked uid ${uid}`);
    }
    assert.ok(!blob.includes('node'), 'summary leaked a node field');
    // Sanity: the fields we DID want are populated.
    assert.equal(r.summary.reassigned.length, 1);
    assert.equal(r.summary.droppedDeps.length, 1);
    assert.equal(r.summary.skippedCards.length, 1);
    assert.deepEqual(r.summary.skippedProjects, ['ghost']);
  });
});

test('malformed remote cards (bad/missing id or state) are skipped, not written', async () => {
  await withRoot(async () => {
    serveDump({ alpha: [
      card({ id: '2026-0001', uid: 'u-ok', title: 'Good' }),
      { uid: 'u-1', title: 'MissingId', state: 'triage' },            // no id
      { id: 42, uid: 'u-2', title: 'NumericId', state: 'triage' },    // non-string id
      card({ id: '2026-0005', uid: 'u-3', title: 'BadState', state: 'archived' }), // unknown column
    ] });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.added, 1); // only the good card
    assert.equal(r.summary.skippedCards.length, 3);
    assert.equal(store.exportTasks('alpha').length, 1);
    assert.equal(byTitle('alpha', 'Good').id, '2026-0001');
  });
});

test('peerUrl to a loopback/private host is blocked (SSRF guard)', async () => {
  await withRoot(async () => {
    for (const host of ['http://127.0.0.1:7100', 'http://localhost:9', 'http://169.254.169.254/latest', 'http://10.0.0.5', 'http://[::1]:8080']) {
      const r = await board.syncPull({ peerUrl: host, scope: 'project', project: 'alpha' });
      assert.equal(r.ok, false, `expected block for ${host}`);
      assert.equal(r.code, 'INVALID_STATE');
      assert.match(r.reason, /loopback|private|link-local|blocked/i);
    }
    // The env escape hatch (used by the local visual harness) allows it through
    // to the fetch, where the stub takes over.
    process.env.CODE_KANBAN_SYNC_ALLOW_PRIVATE = '1';
    try {
      serveDump({ alpha: [card({ id: '2026-0001', uid: 'u-P', title: 'P' })] });
      const r = await board.syncPull({ peerUrl: 'http://127.0.0.1:7100', scope: 'project', project: 'alpha' });
      assert.equal(r.ok, true);
      assert.equal(r.summary.added, 1);
    } finally {
      delete process.env.CODE_KANBAN_SYNC_ALLOW_PRIVATE;
    }
  });
});

// Two boards each with a distinct card that COLLIDES on display id; pull A->B
// then B->A and assert both converge to the same card set (matched by uid +
// content). Display ids may legitimately differ per machine.
test('bidirectional pull converges both boards (union by uid + content)', async () => {
  const rootA = await freshRoot();
  const rootB = await freshRoot(); // freshRoot leaves PROJECTS_ROOT = rootB
  useProjects(['alpha']);
  const setRoot = (d) => { process.env.PROJECTS_ROOT = d; };
  try {
    // Same display id 2026-0001 on both, different cards.
    setRoot(rootA);
    seedLocal('alpha', { id: '2026-0001', uid: 'uX', title: 'X', updated: '2026-03-01T00:00:00.000Z', node: 'nA', state: 'todo' });
    setRoot(rootB);
    seedLocal('alpha', { id: '2026-0001', uid: 'uY', title: 'Y', updated: '2026-03-02T00:00:00.000Z', node: 'nB', state: 'backlog' });

    // Pull A -> B.
    setRoot(rootA);
    const dumpA = await board.exportBoard({ scope: 'all' });
    setRoot(rootB);
    board._setSyncFetcher(async () => dumpA);
    await board.syncPull({ peerUrl: 'http://peer.test', scope: 'all' });

    // Pull B -> A.
    setRoot(rootB);
    const dumpB = await board.exportBoard({ scope: 'all' });
    setRoot(rootA);
    board._setSyncFetcher(async () => dumpB);
    await board.syncPull({ peerUrl: 'http://peer.test', scope: 'all' });

    // Compare by uid + content (NOT display id, which may differ per machine).
    const fingerprint = (root) => {
      setRoot(root);
      return store.exportTasks('alpha')
        .map((c) => ({ uid: c.uid, title: c.title, state: c.state, updated: c.updated, node: c.node }))
        .sort((a, b) => a.uid.localeCompare(b.uid));
    };
    const fpA = fingerprint(rootA);
    const fpB = fingerprint(rootB);
    assert.equal(fpA.length, 2);
    assert.deepEqual(fpA, fpB); // converged
    assert.deepEqual(fpA.map((c) => c.uid), ['uX', 'uY']);
  } finally {
    board._setSyncFetcher(null);
    await cleanup(rootA);
    await cleanup(rootB);
  }
});
