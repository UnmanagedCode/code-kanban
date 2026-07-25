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

// Full dump incl. epics (the shape exportBoard now returns).
function serveFull({ projects = {}, projectEpics = {}, crossEpics = [] }) {
  board._setSyncFetcher(async () => ({ ok: true, nodeId: 'peer-node', projects, projectEpics, crossEpics }));
}

function pEpic(o) {
  return {
    slug: o.slug, title: o.title ?? o.slug, goal: o.goal ?? '', project: o.project ?? 'alpha',
    created: o.created ?? '2026-01-01T00:00:00.000Z',
    updated: o.updated ?? o.created ?? '2026-01-01T00:00:00.000Z',
    node: o.node ?? 'peer-node',
  };
}
function xEpic(o) {
  return {
    slug: o.slug, title: o.title ?? o.slug, goal: o.goal ?? '',
    projects: o.projects ?? ['alpha', 'beta'],
    created: o.created ?? '2026-01-01T00:00:00.000Z',
    updated: o.updated ?? o.created ?? '2026-01-01T00:00:00.000Z',
    node: o.node ?? 'peer-node',
  };
}

function seedProjectEpic(project, o) {
  store.ensureProjectDirs(project);
  const e = pEpic({ ...o, project });
  store.writeEpic(project, e);
  return e;
}
function seedCrossEpic(o) {
  const e = xEpic(o);
  store.writeCrossEpic(e);
  return e;
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
    for (const host of [
      'http://127.0.0.1:7100', 'http://localhost:9', 'http://localhost./', // trailing-dot nit
      'http://169.254.169.254/latest', 'http://10.0.0.5', 'http://[::1]:8080',
      'http://[::ffff:127.0.0.1]', 'http://[::ffff:169.254.169.254]', 'http://[::ffff:10.0.0.5]', // IPv4-mapped IPv6
    ]) {
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

// ---- epic sync ----

test('epic union: a peer project epic is copied in and its card resolves', async () => {
  await withRoot(async () => {
    serveFull({
      projects: { alpha: [card({ id: '2026-0001', uid: 'u-P', title: 'T', epic: 'auth' })] },
      projectEpics: { alpha: [pEpic({ slug: 'auth', title: 'Auth flow' })] },
    });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.epicsAdded, 1);
    assert.equal(r.summary.added, 1);
    const e = await board.readEpic({ project: 'alpha', slug: 'auth' });
    assert.equal(e.ok, true);
    assert.equal(e.epic.title, 'Auth flow');
    // The synced card's epic resolves — the rollup counts it.
    const listed = await board.listEpics({ project: 'alpha' });
    assert.equal(listed.epics.find((x) => x.slug === 'auth').rollup.triage, 1);
  });
});

test('epic LWW: newer peer wins, older loses, tie -> higher node', async () => {
  await withRoot(async () => {
    seedProjectEpic('alpha', { slug: 'auth', title: 'Local', updated: '2026-05-01T00:00:00.000Z', node: 'nL' });
    serveFull({ projects: { alpha: [] }, projectEpics: { alpha: [pEpic({ slug: 'auth', title: 'PeerNew', updated: '2030-01-01T00:00:00.000Z' })] } });
    let r = await pull('project', 'alpha');
    assert.equal(r.summary.epicsUpdated, 1);
    assert.equal((await board.readEpic({ project: 'alpha', slug: 'auth' })).epic.title, 'PeerNew');

    serveFull({ projects: { alpha: [] }, projectEpics: { alpha: [pEpic({ slug: 'auth', title: 'PeerOld', updated: '2000-01-01T00:00:00.000Z' })] } });
    r = await pull('project', 'alpha');
    assert.equal(r.summary.epicsUpdated, 0);
    assert.equal((await board.readEpic({ project: 'alpha', slug: 'auth' })).epic.title, 'PeerNew');

    const cur = store.readEpic('alpha', 'auth'); // equal updated, higher node wins
    serveFull({ projects: { alpha: [] }, projectEpics: { alpha: [pEpic({ slug: 'auth', title: 'PeerTie', updated: cur.updated, node: cur.node + '~' })] } });
    r = await pull('project', 'alpha');
    assert.equal(r.summary.epicsUpdated, 1);
    assert.equal((await board.readEpic({ project: 'alpha', slug: 'auth' })).epic.title, 'PeerTie');
  });
});

test('legacy epic (no stamp) matches by slug; updated backfilled to created; no dup', async () => {
  await withRoot(async () => {
    store.ensureProjectDirs('alpha');
    store.writeEpic('alpha', { slug: 'auth', title: 'Legacy', goal: '', created: '2026-01-01T00:00:00.000Z' });
    serveFull({ projects: { alpha: [] }, projectEpics: { alpha: [pEpic({ slug: 'auth', title: 'Legacy', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', node: 'peer' })] } });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.epicsAdded, 0); // matched by slug, not new
    assert.equal(store.listEpicSlugs('alpha').length, 1); // no duplicate
    assert.equal(store.readEpic('alpha', 'auth').updated, '2026-01-01T00:00:00.000Z'); // backfilled = created
  });
});

test('card.epic slug is kept verbatim (never reassigned/translated)', async () => {
  await withRoot(async () => {
    serveFull({
      projects: { alpha: [card({ id: '2026-0001', uid: 'u-P', title: 'T', epic: 'auth' })] },
      projectEpics: { alpha: [pEpic({ slug: 'auth', title: 'Auth' })] },
    });
    await pull('project', 'alpha');
    assert.equal(byTitle('alpha', 'T').epic, 'auth');
  });
});

test('kind conflict: local cross epic vs incoming project epic -> skip + log', async () => {
  await withRoot(async () => {
    seedCrossEpic({ slug: 'plat', projects: ['alpha', 'beta'], title: 'CrossPlat' });
    serveFull({ projects: { alpha: [] }, projectEpics: { alpha: [pEpic({ slug: 'plat', title: 'ProjPlat' })] } });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.epicConflicts.length, 1);
    assert.equal(r.summary.epicConflicts[0].slug, 'plat');
    assert.equal(store.epicExists('alpha', 'plat'), false); // no second representation
    assert.equal(store.crossEpicExists('plat'), true);
  });
});

test('kind conflict: local project epic vs incoming cross epic -> skip + log', async () => {
  await withRoot(async () => {
    seedProjectEpic('alpha', { slug: 'plat', title: 'ProjPlat' });
    serveFull({ projects: { alpha: [] }, crossEpics: [xEpic({ slug: 'plat', projects: ['alpha', 'beta'], title: 'CrossPlat' })] });
    const r = await pull('all');
    assert.equal(r.summary.epicConflicts.length, 1);
    assert.equal(store.crossEpicExists('plat'), false);
    assert.equal(store.epicExists('alpha', 'plat'), true);
  });
});

test('single-project scope carries cross epics covering the project; card resolves', async () => {
  await withRoot(async () => {
    serveFull({
      projects: { alpha: [card({ id: '2026-0001', uid: 'u-P', title: 'T', epic: 'plat' })] },
      crossEpics: [xEpic({ slug: 'plat', projects: ['alpha', 'beta'], title: 'Platform' })],
    });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.epicsAdded, 1);
    assert.equal(store.crossEpicExists('plat'), true);
    const e = await board.readEpic({ project: 'alpha', slug: 'plat' });
    assert.equal(e.ok, true);
    assert.equal(e.epic.rollup.triage, 1); // the synced card counts under the cross epic
  });
});

test('dangling card.epic (no such epic) is kept verbatim, card uncounted', async () => {
  await withRoot(async () => {
    serveFull({ projects: { alpha: [card({ id: '2026-0001', uid: 'u-P', title: 'T', epic: 'ghost' })] } });
    const r = await pull('project', 'alpha');
    assert.equal(r.summary.added, 1);
    assert.equal(byTitle('alpha', 'T').epic, 'ghost'); // kept, not dropped
    assert.equal((await board.readEpic({ project: 'alpha', slug: 'ghost' })).ok, false);
  });
});

test('epic hidden fields: absent from readEpic/listEpics + summary; present only in export', async () => {
  await withRoot(async () => {
    seedProjectEpic('alpha', { slug: 'auth', title: 'A' });
    seedCrossEpic({ slug: 'plat', projects: ['alpha', 'beta'], title: 'P' });
    const re = await board.readEpic({ project: 'alpha', slug: 'auth' });
    assert.ok(!('updated' in re.epic) && !('node' in re.epic));
    for (const e of (await board.listEpics({ project: 'alpha' })).epics) {
      assert.ok(!('updated' in e) && !('node' in e));
    }
    const exp = await board.exportBoard({ scope: 'all' });
    assert.ok(exp.projectEpics.alpha[0].updated && exp.projectEpics.alpha[0].node);
    assert.ok(exp.crossEpics[0].updated && exp.crossEpics[0].node);
    // The pull summary (GUI-facing) must carry no hidden VALUES — no node id and
    // no `updated` timestamp. (Note `perProject.updated` is a legit COUNT key, so
    // we assert on the values that would leak, not the substring "updated".)
    serveFull({ projects: { alpha: [] }, projectEpics: { alpha: [pEpic({ slug: 'auth', title: 'A2', updated: '2030-01-01T00:00:00.000Z', node: 'secret-node' })] } });
    const blob = JSON.stringify((await pull('project', 'alpha')).summary);
    assert.ok(!blob.includes('secret-node'), 'summary leaked a node id');
    assert.ok(!blob.includes('2030-01-01'), 'summary leaked an updated timestamp');
  });
});

test('malformed epics (bad slug / cross <2 members) are skipped', async () => {
  await withRoot(async () => {
    serveFull({
      projects: { alpha: [] },
      projectEpics: { alpha: [pEpic({ slug: 'ok', title: 'OK' }), pEpic({ slug: 'Bad Slug!', title: 'x' })] },
      crossEpics: [xEpic({ slug: 'lonely', projects: ['alpha'], title: 'x' })],
    });
    const r = await pull('all');
    assert.equal(r.summary.epicsAdded, 1); // only 'ok'
    assert.equal(r.summary.skippedEpics.length, 2);
    assert.equal(store.epicExists('alpha', 'ok'), true);
  });
});

// Two boards; pull A->B then B->A and assert both converge to the SAME card set
// (matched by uid + content; display ids may legitimately differ per machine).
// Covers three cases at once: a display-id collision of DIFFERENT cards (union),
// and two SAME-uid conflicts resolved by LWW — newer `updated` wins, and on an
// exact `updated` tie the higher `node` wins — proving the tiebreak converges
// end-to-end, not just in reasoning.
test('bidirectional pull converges both boards (union + LWW + tiebreak)', async () => {
  const rootA = await freshRoot();
  const rootB = await freshRoot(); // freshRoot leaves PROJECTS_ROOT = rootB
  useProjects(['alpha']);
  const setRoot = (d) => { process.env.PROJECTS_ROOT = d; };
  try {
    setRoot(rootA);
    seedLocal('alpha', { id: '2026-0001', uid: 'uX', title: 'X', updated: '2026-03-01T00:00:00.000Z', node: 'nA', state: 'todo' });     // A-only
    seedLocal('alpha', { id: '2026-0002', uid: 'uZ', title: 'Z-A', updated: '2026-05-02T00:00:00.000Z', node: 'nA', state: 'todo' });    // LWW: A newer
    seedLocal('alpha', { id: '2026-0003', uid: 'uT', title: 'T-A', updated: '2026-06-01T00:00:00.000Z', node: 'zzz', state: 'done' });   // tie: A higher node
    seedProjectEpic('alpha', { slug: 'auth', title: 'E-A', updated: '2026-07-02T00:00:00.000Z', node: 'nA' });          // epic LWW: A newer
    setRoot(rootB);
    seedLocal('alpha', { id: '2026-0001', uid: 'uY', title: 'Y', updated: '2026-03-02T00:00:00.000Z', node: 'nB', state: 'backlog' });   // B-only (collides on 0001)
    seedLocal('alpha', { id: '2026-0002', uid: 'uZ', title: 'Z-B', updated: '2026-05-01T00:00:00.000Z', node: 'nB', state: 'backlog' }); // LWW: B older -> loses
    seedLocal('alpha', { id: '2026-0003', uid: 'uT', title: 'T-B', updated: '2026-06-01T00:00:00.000Z', node: 'aaa', state: 'todo' });   // tie: B lower node -> loses
    seedProjectEpic('alpha', { slug: 'auth', title: 'E-B', updated: '2026-07-01T00:00:00.000Z', node: 'nB' });          // epic LWW: B older -> loses

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
      const byUid = {};
      for (const c of store.exportTasks('alpha')) {
        byUid[c.uid] = { title: c.title, state: c.state, updated: c.updated, node: c.node };
      }
      return byUid;
    };
    const fpA = fingerprint(rootA);
    const fpB = fingerprint(rootB);
    assert.deepEqual(Object.keys(fpA).sort(), ['uT', 'uX', 'uY', 'uZ']);
    assert.deepEqual(fpA, fpB); // both boards converged
    // The LWW winners are the A versions (newer / higher node), on BOTH boards.
    assert.equal(fpA.uZ.title, 'Z-A');
    assert.equal(fpA.uT.title, 'T-A');
    assert.equal(fpB.uZ.title, 'Z-A');
    assert.equal(fpB.uT.title, 'T-A');

    // Epics also converge by slug + content; the newer (A) version wins on both.
    const epicFp = (root) => {
      setRoot(root);
      return store.listEpicSlugs('alpha').map((s) => {
        const e = store.readEpic('alpha', s);
        return { slug: e.slug, title: e.title, updated: e.updated, node: e.node };
      });
    };
    assert.deepEqual(epicFp(rootA), epicFp(rootB));
    assert.equal(epicFp(rootA)[0].title, 'E-A');
  } finally {
    board._setSyncFetcher(null);
    await cleanup(rootA);
    await cleanup(rootB);
  }
});
