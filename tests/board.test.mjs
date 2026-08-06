import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { freshRoot, cleanup } from './_helpers.mjs';
import * as board from '../src/board.js';
import * as store from '../src/store.js';
import { _setProjectFetcher } from '../src/projects.js';
import { _setInstanceFetcher } from '../src/ownerWorktree.js';
import { stateDir, plansDir, projectRepoDir } from '../src/paths.js';

// Creates a real git repo at <root>/<name> with one commit and returns its
// HEAD sha, so tests can assert the auto-captured value against ground truth.
// The commit includes a file with content unique to `name` — otherwise two
// repos created back-to-back with the same empty tree/message/author can
// produce IDENTICAL commit shas (git hashes are pure content, and an
// --allow-empty commit has nothing distinguishing it beyond the timestamp).
function initRepo(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), name);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', dir]);
  git('add', 'marker.txt');
  git('-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '-q', '-m', `init ${name}`);
  return { dir, sha: git('rev-parse', 'HEAD').trim() };
}

// Every test injects a fixed live-project list so validation never hits the net.
function useProjects(names) { _setProjectFetcher(async () => names); }

// Stubs the conductor's /api/instances lookup so a given owner sessionId
// resolves to a fixed cwd, without touching the network (no CONDUCTOR_URL is
// set in tests, so the real default already returns [] — this override is
// only needed when a test wants ownerCwd() to resolve to something).
function useOwnerCwd(sessionId, cwd) {
  _setInstanceFetcher(async () => [{ sessionId, cwd }]);
}

// Pins a card file's mtime to a synthetic instant so _mtimeMs-based tie-break tests
// don't depend on how far apart two writes land on a coarse-mtime filesystem.
function stampMtime(project, state, id, msEpoch) {
  const file = path.join(stateDir(project, state), `${id}.md`);
  fs.utimesSync(file, new Date(msEpoch), new Date(msEpoch));
}

test('file_task -> triage, then full lifecycle to done', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await board.fileTask({ project: 'demo', title: 'Ship it', goal: 'because' });
    assert.equal(f.ok, true);
    const id = f.id;

    assert.equal((await board.moveTask({ project: 'demo', id, to: 'todo' })).ok, true);
    const mv = await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'sess-aaaa1111' });
    assert.deepEqual([mv.from, mv.to], ['todo', 'in-progress']);
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'done' })).ok, true);

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.state, 'done');
    assert.equal(r.task.owner, null); // cleared on leaving in-progress
    // filed + 3 moves
    assert.equal(r.task.logbook.length, 4);
  } finally { await cleanup(root); }
});

test('refusal codes: PROJECT_UNKNOWN, TASK_UNKNOWN, EPIC_UNKNOWN, INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal((await board.listTasks({ project: 'ghost' })).code, 'PROJECT_UNKNOWN');
    assert.equal((await board.readTask({ project: 'demo', id: 'nope' })).code, 'TASK_UNKNOWN');
    assert.equal((await board.fileTask({ project: 'demo', title: 't', epic: 'missing' })).code, 'EPIC_UNKNOWN');

    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    // triage -> in-progress is illegal (must go via todo)
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'in-progress' })).code, 'INVALID_STATE');
    // triage -> triage (no-op) is illegal
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'triage' })).code, 'INVALID_STATE');
  } finally { await cleanup(root); }
});

test('corrective transitions are allowed (demote, abandon, reopen)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'backlog' })).ok, true); // demote
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'todo' })).ok, true);
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 's1' });
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'todo' })).ok, true); // abandon
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 's1' });
    await board.moveTask({ project: 'demo', id, to: 'done' });
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 's1' })).ok, true); // reopen
  } finally { await cleanup(root); }
});

test('log_progress resolves the in-progress card owned by the session', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'owned' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'worker-xyz' });

    // wrong / missing session -> refusal
    assert.equal((await board.logProgress({ project: 'demo', entry: 'hi', sessionId: 'other' })).code, 'TASK_UNKNOWN');
    assert.equal((await board.logProgress({ project: 'demo', entry: 'hi', sessionId: null })).code, 'TASK_UNKNOWN');

    const ok = await board.logProgress({ project: 'demo', entry: 'made progress', sessionId: 'worker-xyz' });
    assert.equal(ok.ok, true);
    const log = await board.readProgress({ project: 'demo', id });
    assert.match(log.entries[0], /made progress/); // most-recent first
  } finally { await cleanup(root); }
});

test('log_progress with two owned cards resolves to the most recently modified', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const a = (await board.fileTask({ project: 'demo', title: 'A' })).id;
    const b = (await board.fileTask({ project: 'demo', title: 'B' })).id;
    for (const id of [a, b]) {
      await board.moveTask({ project: 'demo', id, to: 'todo' });
      await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w' });
    }
    // Pin mtimes so b is deterministically the most-recently-modified, regardless
    // of how close together the moves above land on a coarse-mtime filesystem.
    stampMtime('demo', 'in-progress', a, 1_000_000);
    stampMtime('demo', 'in-progress', b, 2_000_000);
    await board.logProgress({ project: 'demo', entry: 'target-b', sessionId: 'w' });
    const logB = await board.readProgress({ project: 'demo', id: b });
    assert.match(logB.entries[0], /target-b/);
  } finally { await cleanup(root); }
});

test('log_progress with id (conductor path) logs to the specified card, bypassing ownership', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'not owned by caller' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'worker-xyz' });

    // No sessionId at all, and it doesn't match the card's owner -- id bypasses that check.
    const ok = await board.logProgress({ project: 'demo', id, entry: 'checked in', sessionId: null });
    assert.equal(ok.ok, true);
    const log = await board.readProgress({ project: 'demo', id });
    // logLine's null-sessionId -> 'conductor' convention (same one move_task uses).
    assert.match(log.entries[0], /· conductor · checked in/);
  } finally { await cleanup(root); }
});

test('log_progress with id but no project -> INVALID_STATE (ids are per-project)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w' });

    assert.equal(
      (await board.logProgress({ id, entry: 'hi' })).code,
      'INVALID_STATE',
    );
  } finally { await cleanup(root); }
});

test('log_progress with id targeting a non-existent card -> TASK_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal(
      (await board.logProgress({ project: 'demo', id: 'ghost-0001', entry: 'hi' })).code,
      'TASK_UNKNOWN',
    );
  } finally { await cleanup(root); }
});

test('log_progress with id targeting a card that is not in-progress -> TASK_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // filed into triage, never moved -> not in-progress
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    assert.equal(
      (await board.logProgress({ project: 'demo', id, entry: 'hi' })).code,
      'TASK_UNKNOWN',
    );
  } finally { await cleanup(root); }
});

test('log_progress with no id (worker path) is unaffected by the id path', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'owned' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'worker-xyz' });

    // Same session/ownership resolution as before -- explicitly passing id:undefined
    // (as a naive spread of {..., id: a.id} would when id is omitted) must not change behavior.
    const ok = await board.logProgress({ project: 'demo', id: undefined, entry: 'still owner-based', sessionId: 'worker-xyz' });
    assert.equal(ok.ok, true);
    const log = await board.readProgress({ project: 'demo', id });
    assert.match(log.entries[0], /still owner-based/);
  } finally { await cleanup(root); }
});

test('log_progress with no project resolves the owned card in the only project', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'owned' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'worker-xyz' });

    const ok = await board.logProgress({ entry: 'no project needed', sessionId: 'worker-xyz' });
    assert.equal(ok.ok, true);
    const log = await board.readProgress({ project: 'demo', id });
    assert.match(log.entries[0], /no project needed/);
  } finally { await cleanup(root); }
});

test('log_progress with no project scans across projects for the owned card', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'other']);
  try {
    const { id } = await board.fileTask({ project: 'other', title: 'owned elsewhere' });
    await board.moveTask({ project: 'other', id, to: 'todo' });
    await board.moveTask({ project: 'other', id, to: 'in-progress', owner: 'worker-xyz' });

    const ok = await board.logProgress({ entry: 'found in other', sessionId: 'worker-xyz' });
    assert.equal(ok.ok, true);
    const log = await board.readProgress({ project: 'other', id });
    assert.match(log.entries[0], /found in other/);
  } finally { await cleanup(root); }
});

test('log_progress with no project ties-break by most-recently-modified across projects', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'other']);
  try {
    const a = (await board.fileTask({ project: 'demo', title: 'A' })).id;
    await board.moveTask({ project: 'demo', id: a, to: 'todo' });
    await board.moveTask({ project: 'demo', id: a, to: 'in-progress', owner: 'w' });

    const b = (await board.fileTask({ project: 'other', title: 'B' })).id;
    await board.moveTask({ project: 'other', id: b, to: 'todo' });
    await board.moveTask({ project: 'other', id: b, to: 'in-progress', owner: 'w' });

    // Pin mtimes so b is deterministically the most-recently-modified across
    // projects, regardless of real timing.
    stampMtime('demo', 'in-progress', a, 1_000_000);
    stampMtime('other', 'in-progress', b, 2_000_000);

    await board.logProgress({ entry: 'target-b', sessionId: 'w' });
    const logB = await board.readProgress({ project: 'other', id: b });
    assert.match(logB.entries[0], /target-b/);
    // a is untouched: still just its baseline filed + 2 moves, nothing appended.
    const logA = await board.readProgress({ project: 'demo', id: a });
    assert.equal(logA.entries.length, 3);
    assert.doesNotMatch(logA.entries[0], /target-b/);
  } finally { await cleanup(root); }
});

test('log_progress with an explicit project stays scoped to it (fast path unaffected by scan)', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'other']);
  try {
    const a = (await board.fileTask({ project: 'demo', title: 'A' })).id;
    await board.moveTask({ project: 'demo', id: a, to: 'todo' });
    await board.moveTask({ project: 'demo', id: a, to: 'in-progress', owner: 'w' });

    const b = (await board.fileTask({ project: 'other', title: 'B' })).id;
    await board.moveTask({ project: 'other', id: b, to: 'todo' });
    await board.moveTask({ project: 'other', id: b, to: 'in-progress', owner: 'w' });
    // b is the most-recently-modified overall, but an explicit project: 'demo' must target a.

    const ok = await board.logProgress({ project: 'demo', entry: 'target-a', sessionId: 'w' });
    assert.equal(ok.ok, true);
    const logA = await board.readProgress({ project: 'demo', id: a });
    assert.match(logA.entries[0], /target-a/);
    // b is untouched: still just its baseline filed + 2 moves, nothing appended.
    const logB = await board.readProgress({ project: 'other', id: b });
    assert.equal(logB.entries.length, 3);
    assert.doesNotMatch(logB.entries[0], /target-a/);
  } finally { await cleanup(root); }
});

test('log_progress with no project -> TASK_UNKNOWN when nothing is owned anywhere', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'other']);
  try {
    await board.fileTask({ project: 'demo', title: 'untouched' });
    assert.equal(
      (await board.logProgress({ entry: 'hi', sessionId: 'nobody' })).code,
      'TASK_UNKNOWN',
    );
  } finally { await cleanup(root); }
});

test('log_progress with no project and no sessionId -> TASK_UNKNOWN before any scan', async () => {
  const root = await freshRoot();
  let calls = 0;
  _setProjectFetcher(async () => { calls += 1; return ['demo', 'other']; });
  try {
    assert.equal(
      (await board.logProgress({ entry: 'hi', sessionId: null })).code,
      'TASK_UNKNOWN',
    );
    // The no-sessionId refusal must short-circuit before resolveOwningProject
    // ever calls listProjects() (which is backed by this fetcher).
    assert.equal(calls, 0);
  } finally { await cleanup(root); }
});

test('epics: create, file under, rollup counts on read', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal((await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth' })).ok, true);
    const t1 = (await board.fileTask({ project: 'demo', title: 'login', epic: 'auth' })).id;
    await board.fileTask({ project: 'demo', title: 'logout', epic: 'auth' });
    await board.moveTask({ project: 'demo', id: t1, to: 'todo' });

    const list = await board.listEpics({ project: 'demo' });
    assert.equal(list.epics[0].slug, 'auth');
    assert.equal(list.epics[0].rollup.triage, 1);
    assert.equal(list.epics[0].rollup.todo, 1);

    const re = await board.readEpic({ project: 'demo', slug: 'auth' });
    assert.equal(re.tasks.length, 2);
    assert.equal((await board.readEpic({ project: 'demo', slug: 'ghost' })).code, 'EPIC_UNKNOWN');
  } finally { await cleanup(root); }
});

test('cross-project epic: aggregated rollup + tasks span all member projects', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api']);
  try {
    assert.equal((await board.createEpic({ projects: ['web', 'api'], slug: 'platform', title: 'Platform' })).ok, true);
    // File tasks under the same slug in BOTH member projects.
    const w = (await board.fileTask({ project: 'web', title: 'web ui', epic: 'platform' })).id;
    await board.fileTask({ project: 'api', title: 'api svc', epic: 'platform' });
    await board.moveTask({ project: 'web', id: w, to: 'todo' });

    // read_epic by slug alone aggregates across members; each task carries project.
    const re = await board.readEpic({ slug: 'platform' });
    assert.equal(re.ok, true);
    assert.deepEqual(re.epic.projects, ['web', 'api']);
    assert.equal(re.epic.rollup.triage, 1); // api task
    assert.equal(re.epic.rollup.todo, 1);   // web task
    assert.equal(re.tasks.length, 2);
    assert.deepEqual(new Set(re.tasks.map((t) => t.project)), new Set(['web', 'api']));

    // read_epic with a member project resolves the same cross-project epic.
    const viaProject = await board.readEpic({ project: 'web', slug: 'platform' });
    assert.equal(viaProject.tasks.length, 2);

    // list_epics for a member surfaces it (flagged with projects) + aggregated rollup.
    const list = await board.listEpics({ project: 'api' });
    const pe = list.epics.find((e) => e.slug === 'platform');
    assert.deepEqual(pe.projects, ['web', 'api']);
    assert.equal(pe.rollup.triage, 1);
    assert.equal(pe.rollup.todo, 1);
  } finally { await cleanup(root); }
});

test('cross-project epic: fileTask allowed from a member, refused (EPIC_UNKNOWN) from a non-member', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api', 'infra']);
  try {
    await board.createEpic({ projects: ['web', 'api'], slug: 'platform', title: 'Platform' });
    assert.equal((await board.fileTask({ project: 'web', title: 't', epic: 'platform' })).ok, true);
    // infra is not a member, so the epic is not visible there — neither to
    // fileTask nor to a project-scoped read_epic.
    assert.equal((await board.fileTask({ project: 'infra', title: 't', epic: 'platform' })).code, 'EPIC_UNKNOWN');
    assert.equal((await board.readEpic({ project: 'infra', slug: 'platform' })).code, 'EPIC_UNKNOWN');
    // But reading by slug (no project) still returns it.
    assert.equal((await board.readEpic({ slug: 'platform' })).ok, true);
  } finally { await cleanup(root); }
});

test('slug conflict guard refuses in BOTH orders (per-project↔cross-project)', async () => {
  // Order 1: per-project epic exists first, then a cross-project epic over it.
  let root = await freshRoot();
  useProjects(['web', 'api']);
  try {
    assert.equal((await board.createEpic({ project: 'web', slug: 'auth', title: 'Auth' })).ok, true);
    const clash = await board.createEpic({ projects: ['web', 'api'], slug: 'auth', title: 'Auth X' });
    assert.equal(clash.code, 'EPIC_CONFLICT');
  } finally { await cleanup(root); }

  // Order 2: cross-project epic exists first, then a per-project epic in a member.
  root = await freshRoot();
  useProjects(['web', 'api']);
  try {
    assert.equal((await board.createEpic({ projects: ['web', 'api'], slug: 'auth', title: 'Auth X' })).ok, true);
    const clash = await board.createEpic({ project: 'web', slug: 'auth', title: 'Auth' });
    assert.equal(clash.code, 'EPIC_CONFLICT');
    // A per-project epic with that slug in a NON-member project is fine.
    useProjects(['web', 'api', 'other']);
    assert.equal((await board.createEpic({ project: 'other', slug: 'auth', title: 'Auth' })).ok, true);
  } finally { await cleanup(root); }
});

test('create_epic argument validation (project XOR projects; ≥2 members; live members)', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api']);
  try {
    assert.equal((await board.createEpic({ slug: 's', title: 'T' })).code, 'INVALID_STATE'); // neither
    assert.equal((await board.createEpic({ project: 'web', projects: ['web', 'api'], slug: 's', title: 'T' })).code, 'INVALID_STATE'); // both
    assert.equal((await board.createEpic({ projects: ['web'], slug: 's', title: 'T' })).code, 'INVALID_STATE'); // <2
    assert.equal((await board.createEpic({ projects: ['web', 'ghost'], slug: 's', title: 'T' })).code, 'PROJECT_UNKNOWN'); // non-live member
  } finally { await cleanup(root); }
});

test('read_task logTail keeps only the last N entries (0/1/2)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // Build a card with 4 logbook entries: filed + 3 moves.
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w' });
    await board.moveTask({ project: 'demo', id, to: 'done' });
    const full = (await board.readTask({ project: 'demo', id })).task.logbook;
    assert.equal(full.length, 4);

    // logTail:0 must yield zero entries (the slice(-0) trap).
    assert.equal((await board.readTask({ project: 'demo', id, logTail: 0 })).task.logbook.length, 0);
    const one = (await board.readTask({ project: 'demo', id, logTail: 1 })).task.logbook;
    assert.deepEqual(one, full.slice(-1));
    const two = (await board.readTask({ project: 'demo', id, logTail: 2 })).task.logbook;
    assert.deepEqual(two, full.slice(-2));
  } finally { await cleanup(root); }
});

test('update_task applies whitelisted fields and ignores others', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'orig' });
    await board.updateTask({ project: 'demo', id, fields: { title: 'renamed', priority: 5, bogus: 'x', commit: 'sneaky' } });
    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.title, 'renamed');
    assert.equal(r.task.priority, 5);
    assert.equal('bogus' in r.task, false);
    assert.equal(r.task.commit, null); // commit is not in UPDATABLE — update_task can't set it
  } finally { await cleanup(root); }
});

test('delete_task permanently removes the card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'to be deleted' });
    const del = await board.deleteTask({ project: 'demo', id });
    assert.equal(del.ok, true);
    assert.equal((await board.readTask({ project: 'demo', id })).code, 'TASK_UNKNOWN');
  } finally { await cleanup(root); }
});

test('delete_task with an unknown id -> TASK_UNKNOWN (soft refusal, not a throw)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal((await board.deleteTask({ project: 'demo', id: 'ghost-0001' })).code, 'TASK_UNKNOWN');
  } finally { await cleanup(root); }
});

test('delete_task with an unknown project -> PROJECT_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal((await board.deleteTask({ project: 'ghost', id: 'x' })).code, 'PROJECT_UNKNOWN');
  } finally { await cleanup(root); }
});

test('deleting the highest-numbered task does not let a later file_task reuse its id', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await board.fileTask({ project: 'demo', title: 'a' });
    const b = (await board.fileTask({ project: 'demo', title: 'b' })).id; // highest so far
    assert.equal((await board.deleteTask({ project: 'demo', id: b })).ok, true);
    const c = (await board.fileTask({ project: 'demo', title: 'c' })).id;
    assert.notEqual(c, b); // must not reuse the freed id
    assert.ok(c > b); // still strictly higher, not just different
  } finally { await cleanup(root); }
});

test('file_task with category "todo" lands directly in todo, skipping triage', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', category: 'todo' });
    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.state, 'todo');
  } finally { await cleanup(root); }
});

test('file_task with category "backlog" lands directly in backlog', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', category: 'backlog' });
    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.state, 'backlog');
  } finally { await cleanup(root); }
});

test('file_task with an illegal category -> INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal((await board.fileTask({ project: 'demo', title: 't', category: 'done' })).code, 'INVALID_STATE');
    assert.equal((await board.fileTask({ project: 'demo', title: 't', category: 'bogus' })).code, 'INVALID_STATE');
  } finally { await cleanup(root); }
});

test('file_task with category omitted still defaults to triage', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.state, 'triage');
  } finally { await cleanup(root); }
});

test('moveTask auto-captures the OWNER WORKTREE HEAD sha, not the base checkout, on landing', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const base = initRepo(root, 'demo'); // base checkout — must NOT be read from
    const worktree = initRepo(root, 'demo_worktree_deadbeef'); // the owner's actual worktree
    assert.notEqual(base.sha, worktree.sha); // sanity: they really do differ
    useOwnerCwd('w-1', worktree.dir);

    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'done' })).ok, true);

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.commit, worktree.sha);
    assert.notEqual(r.task.commit, base.sha);
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveTask: an explicit commit param overrides auto-capture', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir); // resolvable, but should be ignored in favor of the explicit sha
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveTask({ project: 'demo', id, to: 'done', commit: 'deadbeefcafe' });

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.commit, 'deadbeefcafe');
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveTask: an explicit commit with an embedded newline is sanitized to its first line', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    // A frontmatter-injection attempt: a second "line" that looks like another
    // key. Only the clean first line may ever reach the task file.
    await board.moveTask({ project: 'demo', id, to: 'done', commit: 'cafe1234\nowner: injected' });

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.commit, 'cafe1234');
    assert.equal(r.task.owner, null); // the injected second line never took effect
  } finally { await cleanup(root); }
});

test('moveTask: an explicit commit with internal whitespace is rejected (falls back to auto-capture)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir);
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveTask({ project: 'demo', id, to: 'done', commit: 'not a real sha' });

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.commit, worktree.sha); // the dirty value was rejected, so auto-capture ran instead
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveTask: landing still succeeds with no commit when the owner\'s worktree cannot be resolved', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // No CONDUCTOR_URL is set and no instance fetcher is stubbed, so
    // ownerCwd() resolves to null regardless of the owner sessionId.
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    const mv = await board.moveTask({ project: 'demo', id, to: 'done' });
    assert.equal(mv.ok, true);

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.commit, null);
  } finally { await cleanup(root); }
});

test('moveTask: an instance-lookup failure (e.g. a timed-out fetch) degrades gracefully, no hang', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // Simulates what a timed-out/aborted fetch looks like to ownerCwd: the
    // fetcher rejects. moveTask must still resolve promptly with the move
    // applied and no commit stamped — never hang while holding the lock.
    _setInstanceFetcher(async () => { throw new Error('simulated timeout/abort'); });
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    const mv = await board.moveTask({ project: 'demo', id, to: 'done' });
    assert.equal(mv.ok, true);

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.commit, null);
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveTask: reopening (done -> in-progress) does not clobber the stamped commit', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir);
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveTask({ project: 'demo', id, to: 'done' });
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' })).ok, true); // reopen

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.commit, worktree.sha); // untouched by the reopen move
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveTask: re-landing after reopen captures a FRESH sha, overwriting the prior one', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir);
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveTask({ project: 'demo', id, to: 'done' });
    const firstCommit = (await board.readTask({ project: 'demo', id })).task.commit;
    assert.equal(firstCommit, worktree.sha);

    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' }); // reopen

    // A new commit lands on the same worktree branch before re-landing.
    const git = (...args) => execFileSync('git', ['-C', worktree.dir, ...args], { encoding: 'utf8' });
    fs.writeFileSync(path.join(worktree.dir, 'more.txt'), 'more work');
    git('add', 'more.txt');
    git('-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'more work');
    const freshSha = git('rev-parse', 'HEAD').trim();
    assert.notEqual(freshSha, firstCommit);

    assert.equal((await board.moveTask({ project: 'demo', id, to: 'done' })).ok, true); // re-land

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.commit, freshSha); // overwritten with the fresh sha
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveTask: re-landing preserves the prior commit when nothing resolves this time', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir);
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveTask({ project: 'demo', id, to: 'done' });
    const firstCommit = (await board.readTask({ project: 'demo', id })).task.commit;

    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'w-1' }); // reopen
    _setInstanceFetcher(async () => []); // the owner's worktree is no longer resolvable this time
    assert.equal((await board.moveTask({ project: 'demo', id, to: 'done' })).ok, true); // re-land, unresolvable

    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.commit, firstCommit); // preserved, not cleared
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('the per-project mutex serializes concurrent id assignment (no dupes)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => board.fileTask({ project: 'demo', title: `t${i}` })),
    );
    const ids = results.map((r) => r.id);
    assert.equal(new Set(ids).size, 10); // all unique
  } finally { await cleanup(root); }
});

// ---- plan links + owner reassignment ----

// Write a file under the board's plans/ dir for `project` (the board: base) and
// return its absolute path.
function writeBoardPlan(project, rel, body) {
  const file = path.join(plansDir(project), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// Write a file under the project's BASE checkout (the repo: base). freshRoot()
// sets PROJECTS_ROOT and useProjects() only stubs the catalog, so the checkout
// dir does not exist until a test makes it.
function writeRepoPlan(project, rel, body) {
  const file = path.join(projectRepoDir(project), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

test('update_task sets a board: plan link; read_task returns plan_path', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'planned' });
    const file = writeBoardPlan('demo', 'p.md', '# the plan');
    const u = await board.updateTask({ project: 'demo', id, fields: { plan: 'board:p.md' } });
    assert.equal(u.ok, true);
    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.plan, 'board:p.md');
    assert.equal(r.plan_path, file);
    assert.equal(r.plan_body, undefined); // no body without includePlan
  } finally { await cleanup(root); }
});

test('update_task normalizes a bare plan path to board:', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'planned' });
    writeBoardPlan('demo', 'sub/p.md', 'plan');
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { plan: 'sub/p.md' } })).ok, true);
    // Stored WITH the explicit scheme, so every consumer reads one shape.
    assert.equal((await board.readTask({ project: 'demo', id })).task.plan, 'board:sub/p.md');
  } finally { await cleanup(root); }
});

test('update_task plan pointing at a missing file -> PLAN_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: 'board:nope.md' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.equal((await board.readTask({ project: 'demo', id })).task.plan, null); // nothing stored
  } finally { await cleanup(root); }
});

test('update_task plan pointing at a DIRECTORY -> PLAN_UNKNOWN (must be a regular file)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    fs.mkdirSync(path.join(plansDir('demo'), 'adir'), { recursive: true });
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { plan: 'adir' } })).code, 'PLAN_UNKNOWN');
  } finally { await cleanup(root); }
});

test('update_task plan via a symlink out of plans/ -> PLAN_UNKNOWN (no arbitrary-file read)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    fs.mkdirSync(plansDir('demo'), { recursive: true });
    fs.symlinkSync(secret, path.join(plansDir('demo'), 'escape.md'));
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: 'board:escape.md' } });
    assert.equal(r.code, 'PLAN_UNKNOWN'); // statSync follows the link, the realpath check catches it
  } finally { await cleanup(root); }
});

test('update_task plan with an absolute path -> INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const abs = writeBoardPlan('demo', 'p.md', 'plan'); // exists — refused on grammar, not existence
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: abs } });
    assert.equal(r.code, 'INVALID_STATE');
    assert.match(r.reason, /relative/);
  } finally { await cleanup(root); }
});

test('update_task plan with ../ traversal -> INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    // A real file one level ABOVE plans/ — reachable only if containment fails.
    fs.mkdirSync(plansDir('demo'), { recursive: true });
    fs.writeFileSync(path.join(plansDir('demo'), '..', 'outside.md'), 'nope');
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: '../outside.md' } });
    assert.equal(r.code, 'INVALID_STATE');
    assert.equal((await board.readTask({ project: 'demo', id })).task.plan, null);
  } finally { await cleanup(root); }
});

test('update_task plan: null clears the link', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    writeBoardPlan('demo', 'p.md', 'plan');
    await board.updateTask({ project: 'demo', id, fields: { plan: 'p.md' } });
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { plan: null } })).ok, true);
    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.plan, null);
    assert.equal(r.plan_path, null);
  } finally { await cleanup(root); }
});

test('update_task repo: plan link fails while unmerged -> PLAN_UNKNOWN, passes once the file exists', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const link = 'repo:docs/plans/x.md';
    // Unmerged: nothing at that path in the BASE checkout yet.
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { plan: link } })).code, 'PLAN_UNKNOWN');
    const file = writeRepoPlan('demo', 'docs/plans/x.md', '# merged plan');
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { plan: link } })).ok, true);
    const r = await board.readTask({ project: 'demo', id, includePlan: true });
    assert.equal(r.task.plan, link);
    assert.equal(r.plan_path, file);
    assert.equal(r.plan_body, '# merged plan');
  } finally { await cleanup(root); }
});

test('read_task includePlan returns the plan body', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    writeBoardPlan('demo', 'p.md', 'line one\nline two\n');
    await board.updateTask({ project: 'demo', id, fields: { plan: 'p.md' } });
    const r = await board.readTask({ project: 'demo', id, includePlan: true });
    assert.equal(r.plan_body, 'line one\nline two\n');
    assert.equal(r.plan_truncated, false);
    assert.equal(r.plan_missing, false);
  } finally { await cleanup(root); }
});

test('read_task includePlan sets plan_truncated over the cap', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const big = 'x'.repeat(65536 + 100);
    writeBoardPlan('demo', 'big.md', big);
    await board.updateTask({ project: 'demo', id, fields: { plan: 'big.md' } });
    const r = await board.readTask({ project: 'demo', id, includePlan: true });
    assert.equal(r.plan_truncated, true);
    assert.equal(r.plan_body.length, 65536); // cut at the cap, not the file size
    assert.equal(r.plan_missing, false);
  } finally { await cleanup(root); }
});

test('read_task includePlan on a missing plan file -> plan_body null + plan_missing (never a refusal)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const file = writeBoardPlan('demo', 'p.md', 'plan');
    await board.updateTask({ project: 'demo', id, fields: { plan: 'p.md' } });
    fs.rmSync(file); // e.g. the card synced in from a peer that holds the file
    const r = await board.readTask({ project: 'demo', id, includePlan: true });
    assert.equal(r.ok, true);
    assert.equal(r.plan_body, null);
    assert.equal(r.plan_missing, true);
    assert.equal(r.plan_path, file); // still resolved — a dead link, not an error
  } finally { await cleanup(root); }
});

test('read_task on an ungrammatical stored plan link -> plan_path null, no refusal', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    // Simulate a card synced from a newer peer: write the raw frontmatter value.
    const t = store.readTaskById('demo', id);
    t.plan = 'weird:thing.md';
    store.writeTask('demo', 'triage', t);
    const r = await board.readTask({ project: 'demo', id, includePlan: true });
    assert.equal(r.ok, true);
    assert.equal(r.plan_path, null);
    assert.equal(r.plan_body, null);
    assert.equal(r.plan_missing, true);
  } finally { await cleanup(root); }
});

test('update_task owner off in-progress -> INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' }); // triage
    const r = await board.updateTask({ project: 'demo', id, fields: { owner: 'sess-2' } });
    assert.equal(r.code, 'INVALID_STATE');
    assert.equal((await board.readTask({ project: 'demo', id })).task.owner, null);
  } finally { await cleanup(root); }
});

test('update_task owner on an in-progress card logs owner <from> -> <to>, and null clears it', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'sess-plan' });

    assert.equal((await board.updateTask({ project: 'demo', id, fields: { owner: 'sess-impl' } })).ok, true);
    let r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.owner, 'sess-impl');
    assert.match(r.task.logbook.at(-1), /owner sess-plan -> sess-impl$/);
    assert.equal(r.task.state, 'in-progress'); // no lane move

    assert.equal((await board.updateTask({ project: 'demo', id, fields: { owner: null } })).ok, true);
    r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.owner, null);
    assert.match(r.task.logbook.at(-1), /owner sess-impl -> none$/);
  } finally { await cleanup(root); }
});

test('update_task owner with the same value logs nothing', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'sess-1' });
    const before = (await board.readTask({ project: 'demo', id })).task.logbook.length;
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { owner: 'sess-1' } })).ok, true);
    const after = (await board.readTask({ project: 'demo', id })).task.logbook;
    assert.equal(after.length, before);
    assert.equal(after.filter((l) => l.includes('owner ')).length, 0);
  } finally { await cleanup(root); }
});

test('update_task owner with whitespace or an empty value -> INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'sess-1' });
    for (const v of ['', 'a b', 'a\nowner: b', 7]) {
      assert.equal((await board.updateTask({ project: 'demo', id, fields: { owner: v } })).code, 'INVALID_STATE', `owner ${JSON.stringify(v)} refused`);
    }
    assert.equal((await board.readTask({ project: 'demo', id })).task.owner, 'sess-1'); // untouched
  } finally { await cleanup(root); }
});

test('update_task: a refused plan leaves the other fields unapplied (validation precedes mutation)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'orig' });
    const r = await board.updateTask({ project: 'demo', id, fields: { title: 'renamed', plan: 'board:ghost.md' } });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.equal((await board.readTask({ project: 'demo', id })).task.title, 'orig');
  } finally { await cleanup(root); }
});

test('delete_task removes a board: plan file and never a repo: one', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const a = await board.fileTask({ project: 'demo', title: 'board-planned' });
    const boardPlan = writeBoardPlan('demo', 'a.md', 'board plan');
    await board.updateTask({ project: 'demo', id: a.id, fields: { plan: 'board:a.md' } });

    const b = await board.fileTask({ project: 'demo', title: 'repo-planned' });
    const repoPlan = writeRepoPlan('demo', 'docs/b.md', 'repo plan');
    await board.updateTask({ project: 'demo', id: b.id, fields: { plan: 'repo:docs/b.md' } });

    assert.equal((await board.deleteTask({ project: 'demo', id: a.id })).ok, true);
    assert.equal(fs.existsSync(boardPlan), false); // the card's own plan file goes with it

    assert.equal((await board.deleteTask({ project: 'demo', id: b.id })).ok, true);
    assert.equal(fs.existsSync(repoPlan), true); // a source-tree file is NEVER touched
  } finally { await cleanup(root); }
});

test('delete_task with an already-missing board: plan file still succeeds', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const file = writeBoardPlan('demo', 'p.md', 'plan');
    await board.updateTask({ project: 'demo', id, fields: { plan: 'p.md' } });
    fs.rmSync(file);
    assert.equal((await board.deleteTask({ project: 'demo', id })).ok, true);
  } finally { await cleanup(root); }
});

test('list_tasks summary carries the plan link', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const a = await board.fileTask({ project: 'demo', title: 'planned' });
    await board.fileTask({ project: 'demo', title: 'unplanned' });
    writeBoardPlan('demo', 'p.md', 'plan');
    await board.updateTask({ project: 'demo', id: a.id, fields: { plan: 'p.md' } });
    const { tasks } = await board.listTasks({ project: 'demo' });
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    assert.equal(byId[a.id].plan, 'board:p.md');
    assert.equal(tasks.filter((t) => !t.plan).length, 1);
  } finally { await cleanup(root); }
});
