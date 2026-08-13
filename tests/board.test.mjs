import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

test('update_task applies whitelisted fields (incl. acceptance) and ignores others', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'orig', acceptance: ['a'] });
    await board.updateTask({
      project: 'demo', id,
      fields: { title: 'renamed', priority: 'CRITICAL', bogus: 'x', commit: 'sneaky', acceptance: { replace: ['b'] } },
    });
    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.title, 'renamed');
    assert.equal(r.task.priority, 'CRITICAL');
    assert.equal('bogus' in r.task, false);
    assert.equal(r.task.commit, null); // commit is not in UPDATABLE — update_task can't set it
    assert.deepEqual(r.task.acceptance, [{ text: 'b', done: false }]); // acceptance joined UPDATABLE
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

// A source dir OUTSIDE PROJECTS_ROOT (its own mkdtemp — freshRoot's dir is a
// tmpdir too, so "outside" has to be a sibling), mirroring the ~/.claude/plans/
// location that ingest exists for. Cleaned up by the caller.
function outsideSources() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kanban-src-'));
  return {
    dir,
    write(name, body) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      return file;
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// The board's ingest destination for a card.
function ingestDest(project, id) { return path.join(plansDir(project), `${id}.md`); }

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

// NO LOCATION SNIFFING: an absolute path INSIDE plans/ is copied like any other
// source, rather than being normalised back to a board: pointer at itself.
test('update_task plan: an absolute path inside plans/ is copied like any other source', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const abs = writeBoardPlan('demo', 'p.md', 'the p.md plan');
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: abs } });
    assert.equal(r.ok, true);
    assert.equal(r.plan, `board:${id}.md`);
    assert.equal((await board.readTask({ project: 'demo', id })).task.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), 'the p.md plan');
    assert.equal(fs.readFileSync(abs, 'utf8'), 'the p.md plan'); // the source survives
  } finally { await cleanup(root); }
});

// OUTCOME test, not proof of the guard. Re-attaching plans/<id>.md by absolute
// path must succeed, store the link, and leave the content intact. It does NOT
// demonstrate that ingestPlanFile's self-copy guard is load-bearing: with the
// guard removed, libuv's same-inode short-circuit keeps this green too, so the
// assertions below pass either way (see the guard's comment in src/board.js).
test('update_task plan: an absolute path AT the destination succeeds with the content intact', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const abs = writeBoardPlan('demo', `${id}.md`, 'SELF');
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: abs } });
    assert.equal(r.ok, true);
    assert.equal(r.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'SELF'); // intact
    assert.equal((await board.readTask({ project: 'demo', id, includePlan: true })).plan_body, 'SELF');
  } finally { await cleanup(root); }
});

// The symlink form of the same OUTCOME: as strings source !== dest, so only the
// guard's realpath comparison recognises it — but, like the test above, this
// asserts the outcome and cannot prove the guard (libuv no-ops a same-inode copy
// regardless). Both mutants on the guard are waived expected survivors.
test('update_task plan: an absolute SYMLINK to the destination succeeds with the content intact', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const dest = writeBoardPlan('demo', `${id}.md`, 'SELF VIA SYMLINK');
    const link = path.join(src.dir, 'alias.md');
    fs.symlinkSync(dest, link);
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: link } });
    assert.equal(r.ok, true);
    assert.equal(r.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'SELF VIA SYMLINK'); // intact
  } finally { src.cleanup(); await cleanup(root); }
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
    const cleared = await board.updateTask({ project: 'demo', id, fields: { plan: null } });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.plan, null); // reported, because fields.plan was in the call
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

// ---- plan ingest (a bare ABSOLUTE input is copied into the board) ----

test('update_task plan: an absolute path outside PROJECTS_ROOT is ingested as board:<id>.md', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'planned' });
    const source = src.write('deep-dive.md', '# the host plan\nbody\n');
    const u = await board.updateTask({ project: 'demo', id, fields: { plan: source } });
    assert.equal(u.ok, true);
    // Named from the CARD's id, not the source basename.
    assert.equal(u.plan, `board:${id}.md`);
    assert.equal((await board.readTask({ project: 'demo', id })).task.plan, `board:${id}.md`);
    assert.equal(fs.existsSync(path.join(plansDir('demo'), 'deep-dive.md')), false);
    // The copy is a real byte-for-byte copy, and readable through read_task.
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), '# the host plan\nbody\n');
    const r = await board.readTask({ project: 'demo', id, includePlan: true });
    assert.equal(r.plan_body, '# the host plan\nbody\n');
    assert.equal(r.plan_missing, false);
    // COPY, not move: the source is untouched.
    assert.equal(fs.existsSync(source), true);
    assert.equal(fs.readFileSync(source, 'utf8'), '# the host plan\nbody\n');
  } finally { src.cleanup(); await cleanup(root); }
});

test('update_task plan ingest creates plans/ when the project dir predates it', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    fs.rmSync(plansDir('demo'), { recursive: true, force: true }); // no plans/ at all
    assert.equal(fs.existsSync(plansDir('demo')), false);
    const source = src.write('p.md', 'made the dir');
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { plan: source } })).ok, true);
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), 'made the dir');
  } finally { src.cleanup(); await cleanup(root); }
});

test('update_task plan ingest of a revised plan OVERWRITES the board copy (no versioning)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const a = src.write('a.md', 'FIRST');
    const b = src.write('b.md', 'SECOND');
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { plan: a } })).ok, true);
    const second = await board.updateTask({ project: 'demo', id, fields: { plan: b } });
    assert.equal(second.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), 'SECOND');
    // Last write wins into ONE file — no suffixed sibling, no skip-if-exists.
    assert.deepEqual(fs.readdirSync(plansDir('demo')), [`${id}.md`]);
  } finally { src.cleanup(); await cleanup(root); }
});

test('update_task plan: a board: POINTER is never copied and never clobbers plans/<id>.md', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const other = writeBoardPlan('demo', 'other.md', 'X');
    const dest = writeBoardPlan('demo', `${id}.md`, 'SENTINEL');
    const u = await board.updateTask({ project: 'demo', id, fields: { plan: 'board:other.md' } });
    assert.equal(u.ok, true);
    assert.equal(u.plan, 'board:other.md');
    assert.equal((await board.readTask({ project: 'demo', id })).task.plan, 'board:other.md');
    assert.equal(fs.readFileSync(other, 'utf8'), 'X');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'SENTINEL'); // untouched
  } finally { await cleanup(root); }
});

test('update_task plan: a repo: POINTER is never copied into the board', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const repoFile = writeRepoPlan('demo', 'docs/plans/x.md', '# in-tree plan');
    const u = await board.updateTask({ project: 'demo', id, fields: { plan: 'repo:docs/plans/x.md' } });
    assert.equal(u.plan, 'repo:docs/plans/x.md');
    assert.equal(fs.readFileSync(repoFile, 'utf8'), '# in-tree plan');
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
  } finally { await cleanup(root); }
});

test('update_task plan: a BARE RELATIVE path is a pointer, not an ingest', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    writeBoardPlan('demo', 'p.md', 'plan');
    const u = await board.updateTask({ project: 'demo', id, fields: { plan: 'p.md' } });
    assert.equal(u.plan, 'board:p.md');
    assert.equal(fs.existsSync(ingestDest('demo', id)), false); // nothing copied
  } finally { await cleanup(root); }
});

// The real-world common case: the plan file lives in the worker's WORKTREE, which
// `repo:` (the base checkout) cannot reach. Ingest copies it — and the worktree
// dir is never mistaken for the project itself.
test('update_task plan: an absolute path inside a WORKTREE is copied in', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const wt = path.join(root, 'demo_worktree_ab12');
    fs.mkdirSync(wt, { recursive: true });
    const source = path.join(wt, 'plan.md');
    fs.writeFileSync(source, '# worktree plan');
    const u = await board.updateTask({ project: 'demo', id, fields: { plan: source } });
    assert.equal(u.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), '# worktree plan');
    assert.equal(fs.readFileSync(source, 'utf8'), '# worktree plan');
  } finally { await cleanup(root); }
});

test('update_task plan: a MISSING absolute source -> PLAN_UNKNOWN, card unchanged', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    writeBoardPlan('demo', 'p.md', 'the earlier plan');
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { plan: 'board:p.md' } })).ok, true);
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: path.join(src.dir, 'nope.md') } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PLAN_UNKNOWN');
    // Validation precedes mutation: the earlier link stands and nothing was written.
    assert.equal((await board.readTask({ project: 'demo', id })).task.plan, 'board:p.md');
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
  } finally { src.cleanup(); await cleanup(root); }
});

test('update_task plan: a DIRECTORY as the absolute source -> PLAN_UNKNOWN, refused by the stat', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const dir = path.join(src.dir, 'adir');
    fs.mkdirSync(dir, { recursive: true });
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: dir } });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    // The isFile() check refuses it, NOT a failed copy: without that check the
    // copy would refuse too (EISDIR), so pin which guard spoke.
    assert.match(r.reason, /not a regular file/);
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
  } finally { src.cleanup(); await cleanup(root); }
});

// The case the isFile() check is really load-bearing for: a source copyFileSync
// would happily accept, silently ingesting a bogus plan (an empty one, here).
test('update_task plan: a NON-REGULAR absolute source (character device) -> PLAN_UNKNOWN', async (t) => {
  if (!fs.existsSync('/dev/null')) return t.skip('no /dev/null on this platform');
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: '/dev/null' } });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.match(r.reason, /not a regular file/);
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
    assert.equal((await board.readTask({ project: 'demo', id })).task.plan, null);
  } finally { await cleanup(root); }
});

test('update_task plan: a DANGLING SYMLINK as the absolute source -> PLAN_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const link = path.join(src.dir, 'dangling.md');
    fs.symlinkSync(path.join(src.dir, 'gone.md'), link); // statSync follows -> ENOENT
    const r = await board.updateTask({ project: 'demo', id, fields: { plan: link } });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
  } finally { src.cleanup(); await cleanup(root); }
});

// ---- file_task's plan param (same three input forms, same validator) ----

test('file_task ingests an absolute plan into the CARD\'s own id', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const source = src.write('wake-plan.md', '# filed with a plan');
    const f = await board.fileTask({ project: 'demo', title: 't', plan: source });
    assert.equal(f.ok, true);
    assert.equal(f.plan, `board:${f.id}.md`);
    assert.equal(fs.readFileSync(ingestDest('demo', f.id), 'utf8'), '# filed with a plan');
    const r = await board.readTask({ project: 'demo', id: f.id, includePlan: true });
    assert.equal(r.task.plan, `board:${f.id}.md`);
    assert.equal(r.plan_body, '# filed with a plan');
  } finally { src.cleanup(); await cleanup(root); }
});

test('file_task with an unreadable absolute plan -> PLAN_UNKNOWN: no card, no id burned', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.fileTask({ project: 'demo', title: 't', plan: '/nope/definitely-not-here.md' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.equal(r.id, undefined);
    // Copy-then-write: nothing was created...
    assert.deepEqual((await board.listTasks({ project: 'demo' })).tasks, []);
    // ...and nextId consumed nothing, so the next filing gets the first id.
    const next = await board.fileTask({ project: 'demo', title: 'after' });
    assert.equal(next.id, `${new Date().getFullYear()}-0001`);
  } finally { await cleanup(root); }
});

test('file_task with a board: pointer at a missing file -> PLAN_UNKNOWN, no card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.fileTask({ project: 'demo', title: 't', plan: 'board:ghost.md' });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.deepEqual((await board.listTasks({ project: 'demo' })).tasks, []);
  } finally { await cleanup(root); }
});

test('file_task with a malformed plan -> INVALID_STATE before the lock, no card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.fileTask({ project: 'demo', title: 't', plan: 'board:/abs/p.md' });
    assert.equal(r.code, 'INVALID_STATE');
    assert.match(r.reason, /relative/);
    assert.deepEqual((await board.listTasks({ project: 'demo' })).tasks, []);
  } finally { await cleanup(root); }
});

test('file_task with a POINTER plan copies nothing', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    writeBoardPlan('demo', 'other.md', 'shared plan');
    const f = await board.fileTask({ project: 'demo', title: 't', plan: 'board:other.md' });
    assert.equal(f.plan, 'board:other.md');
    assert.equal(fs.existsSync(ingestDest('demo', f.id)), false);
    assert.deepEqual(fs.readdirSync(plansDir('demo')), ['other.md']);
  } finally { await cleanup(root); }
});

test('file_task without a plan reports no plan key (response shape unchanged)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await board.fileTask({ project: 'demo', title: 't' });
    assert.equal('plan' in f, false);
    assert.equal((await board.readTask({ project: 'demo', id: f.id })).task.plan, null);
    const u = await board.updateTask({ project: 'demo', id: f.id, fields: { title: 'u' } });
    assert.equal('plan' in u, false); // only reported when fields.plan was in the call
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

test('read_task includePlan at EXACTLY the cap is not truncated', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't' });
    const exact = 'x'.repeat(65536); // PLAN_MAX_BYTES to the byte
    writeBoardPlan('demo', 'exact.md', exact);
    await board.updateTask({ project: 'demo', id, fields: { plan: 'exact.md' } });
    const r = await board.readTask({ project: 'demo', id, includePlan: true });
    // The cap is `size > PLAN_MAX_BYTES`, not `>=` — a file that exactly fills
    // it is returned whole and NOT flagged.
    assert.equal(r.plan_truncated, false);
    assert.equal(r.plan_body, exact);
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

// ---- priority ----------------------------------------------------------
//
// The field is an enum (src/priority.js) plus a first-class UNSET state. These
// pin the things a mutant can quietly break: the rank ORDER (and specifically
// that unset sorts LAST), that unset round-trips through a clear, that a refusal
// never half-writes, and that a card written by the pre-enum build still loads
// and sorts.

// Write a task file straight into a column dir, bypassing board.js entirely —
// the only way to fabricate the exact frontmatter an OLD build produced.
function seedRawCard(project, state, { id, priorityLine, created = '2026-01-01T00:00:00.000Z' }) {
  const dir = stateDir(project, state);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), [
    '---',
    `id: ${id}`,
    `title: legacy ${id}`,
    `project: ${project}`,
    ...(priorityLine === null ? [] : [`priority: ${priorityLine}`]),
    `created: ${created}`,
    'depends_on: []',
    '---',
    '',
    '## Goal',
    '',
    '## Acceptance',
    '',
    '## Logbook',
    '',
  ].join('\n'));
}

test('file_task leaves priority UNSET when omitted — it never invents a level', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'no priority given' });
    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.priority, null);
    // Explicitly not laundered into the middle of the ladder, which is the
    // regression this card corrects.
    assert.notEqual(r.task.priority, 'MEDIUM');
    // And on DISK the key is ABSENT, not written as a word or a number.
    const raw = fs.readFileSync(path.join(stateDir('demo', 'triage'), `${id}.md`), 'utf8');
    assert.equal(/^priority:/m.test(raw), false, raw);
  } finally { await cleanup(root); }
});

test('file_task treats an explicit null priority as unset, same as omitting it', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'explicit null', priority: null });
    assert.equal((await board.readTask({ project: 'demo', id })).task.priority, null);
  } finally { await cleanup(root); }
});

test('file_task accepts an explicit priority and persists it', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    for (const level of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
      const { id } = await board.fileTask({ project: 'demo', title: level, priority: level });
      assert.equal((await board.readTask({ project: 'demo', id })).task.priority, level);
    }
  } finally { await cleanup(root); }
});

test('file_task refuses an unrecognised priority and files no card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // Everything the DISK parser would tolerate must be refused here — that
    // split is the design (see .wiki/gotchas/priority-legacy-tolerance.md).
    // (null is absent from this list on purpose — it is the explicit "unset"
    // token, covered by its own test above.)
    for (const bad of ['URGENT', 'medium', 'Critical', '', 7, 2, 0, ['HIGH']]) {
      const r = await board.fileTask({ project: 'demo', title: 'nope', priority: bad });
      assert.equal(r.ok, false, `priority ${JSON.stringify(bad)} should refuse`);
      assert.equal(r.code, 'INVALID_STATE', JSON.stringify(bad));
    }
    // What this pins: a refusal performs NO store.writeTask. Nothing is listed,
    // and the next real card still gets -0001 — the id floor is bumped by
    // writeTask, not by store.nextId (which is a read), so a consumed id would
    // mean a card file had been written.
    assert.deepEqual((await board.listTasks({ project: 'demo' })).tasks, []);
    const { id } = await board.fileTask({ project: 'demo', title: 'first real card' });
    assert.equal(id.endsWith('-0001'), true, `a refusal wrote a card: ${id}`);
  } finally { await cleanup(root); }
});

test('update_task refuses a bad priority and leaves the WHOLE card untouched', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'orig', priority: 'LOW' });
    // A valid title rides along with the bad priority, and NEITHER lands. What
    // guarantees that is not the ordering of the checks but the single terminal
    // store.writeTask (board.js:417-420): `task` is an in-memory parse, so any
    // refusal path returns before anything is persisted. This pins that
    // property — a mutant that persists mid-loop lets the title through.
    const r = await board.updateTask({ project: 'demo', id, fields: { title: 'renamed', priority: 'URGENT' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_STATE');
    const after = (await board.readTask({ project: 'demo', id })).task;
    assert.equal(after.title, 'orig');
    assert.equal(after.priority, 'LOW');
  } finally { await cleanup(root); }
});

test('update_task refuses every non-level value except null', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'x', priority: 'HIGH' });
    // `undefined` is included: only an explicit null clears. A mutant widening
    // the clear token to any nullish value would let a dropped/typo'd field
    // silently erase a judgement.
    for (const bad of ['', 'high', 3, '3', undefined]) {
      const r = await board.updateTask({ project: 'demo', id, fields: { priority: bad } });
      assert.equal(r.ok, false, `priority ${JSON.stringify(bad)} should refuse`);
      assert.equal(r.code, 'INVALID_STATE', JSON.stringify(bad));
    }
    assert.equal((await board.readTask({ project: 'demo', id })).task.priority, 'HIGH');
  } finally { await cleanup(root); }
});

test('update_task clears priority back to unset with null, and it ROUND-TRIPS', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'judged then unjudged', priority: 'HIGH' });
    const cardPath = path.join(stateDir('demo', 'triage'), `${id}.md`);
    assert.ok(fs.readFileSync(cardPath, 'utf8').includes('\npriority: HIGH\n'));

    const cleared = await board.updateTask({ project: 'demo', id, fields: { priority: null } });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));

    // Three separate observations, because a clear can fail at three stages:
    // 1. the value the service layer returns,
    assert.equal((await board.readTask({ project: 'demo', id })).task.priority, null);
    // 2. what actually reached DISK (a clear that only lived in memory would
    //    pass step 1 and be lost on the next process),
    const raw = fs.readFileSync(cardPath, 'utf8');
    assert.equal(/^priority:/m.test(raw), false, raw);
    // 3. and that re-reading that file yields unset rather than a level — the
    //    round trip proper. It must not come back as MEDIUM.
    const reread = (await board.readTask({ project: 'demo', id })).task;
    assert.equal(reread.priority, null);
    assert.notEqual(reread.priority, 'MEDIUM');

    // And the card is still fully intact + re-judgeable afterwards.
    assert.equal(reread.title, 'judged then unjudged');
    assert.equal((await board.updateTask({ project: 'demo', id, fields: { priority: 'LOW' } })).ok, true);
    assert.equal((await board.readTask({ project: 'demo', id })).task.priority, 'LOW');
  } finally { await cleanup(root); }
});

test('list_tasks sorts CRITICAL first, LOW last, and UNSET after LOW', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // Filed so that ID order CONTRADICTS priority order: ids ascend 0001..0005
    // while ranks descend. An implementation that dropped the priority key (or
    // reversed it) cannot produce the expected sequence by falling through to
    // the id tiebreak.
    //
    // The UNSET card is filed FIRST, so it holds the LOWEST id. That is the
    // point: it must still come last. Two distinct mutants die here —
    //   * "unset ranks first"  -> it leads (its old integer-0 behaviour)
    //   * "unset ranks MEDIUM" -> it lands ahead of `low`, because on a rank tie
    //                             with `med` its smaller id wins the tiebreak.
    const unset = (await board.fileTask({ project: 'demo', title: 'u' })).id;
    const low = (await board.fileTask({ project: 'demo', title: 'l', priority: 'LOW' })).id;
    const med = (await board.fileTask({ project: 'demo', title: 'm', priority: 'MEDIUM' })).id;
    const high = (await board.fileTask({ project: 'demo', title: 'h', priority: 'HIGH' })).id;
    const crit = (await board.fileTask({ project: 'demo', title: 'c', priority: 'CRITICAL' })).id;
    // ids really do ascend in filing order, so the tiebreak genuinely opposes us
    assert.deepEqual([unset, low, med, high, crit].sort(), [unset, low, med, high, crit]);

    const ids = (await board.listTasks({ project: 'demo' })).tasks.map((t) => t.id);
    assert.deepEqual(ids, [crit, high, med, low, unset]);
    // Stated as their own claims so a failure names the broken invariant.
    assert.ok(ids.indexOf(low) < ids.indexOf(unset), 'unset must sort BELOW a deliberate LOW');
    assert.ok(ids.indexOf(med) < ids.indexOf(unset), 'unset must not rank as MEDIUM');
    assert.equal(ids.at(-1), unset, 'unset must be last');
  } finally { await cleanup(root); }
});

test('column order dominates priority; id breaks a priority tie', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // A LOW card further left must still precede a CRITICAL card further right.
    const lowTodo = (await board.fileTask({ project: 'demo', title: 'low/todo', priority: 'LOW', category: 'todo' })).id;
    const critDone = (await board.fileTask({ project: 'demo', title: 'crit/done', priority: 'CRITICAL', category: 'todo' })).id;
    await board.moveTask({ project: 'demo', id: critDone, to: 'in-progress' });
    await board.moveTask({ project: 'demo', id: critDone, to: 'done' });
    // Two UNSET cards in one column: ascending id decides.
    const u1 = (await board.fileTask({ project: 'demo', title: 'u1', category: 'todo' })).id;
    const u2 = (await board.fileTask({ project: 'demo', title: 'u2', category: 'todo' })).id;

    const ids = (await board.listTasks({ project: 'demo' })).tasks.map((t) => t.id);
    // lowTodo leads its column despite a later id — unset does not outrank LOW.
    assert.deepEqual(ids, [lowTodo, u1, u2, critDone]);
    assert.ok(ids.indexOf(lowTodo) < ids.indexOf(critDone), 'column must dominate priority');
    assert.ok(ids.indexOf(u1) < ids.indexOf(u2), 'equal priority falls through to ascending id');
    // An UNSET card in an earlier column still precedes a CRITICAL one further
    // right: column dominance holds for unset too, not just for judged levels.
    assert.ok(ids.indexOf(u1) < ids.indexOf(critDone), 'column must dominate unset as well');
  } finally { await cleanup(root); }
});

test('a card written by the pre-enum build still loads, and sorts by its mapped level', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    store.ensureProjectDirs('demo');
    // Exactly what an older build left on disk: the legacy ladder, the
    // ubiquitous unset 0 (all 166 live cards), an out-of-range int, an unknown
    // word, and a card with no priority key at all.
    seedRawCard('demo', 'todo', { id: '2026-0001', priorityLine: '0' });
    seedRawCard('demo', 'todo', { id: '2026-0002', priorityLine: '1' });
    seedRawCard('demo', 'todo', { id: '2026-0003', priorityLine: '4' });
    seedRawCard('demo', 'todo', { id: '2026-0004', priorityLine: '9' });
    seedRawCard('demo', 'todo', { id: '2026-0005', priorityLine: 'URGENT' });
    seedRawCard('demo', 'todo', { id: '2026-0006', priorityLine: null });

    const listed = (await board.listTasks({ project: 'demo' })).tasks;
    // Not one card is dropped, and nothing threw on the way.
    assert.equal(listed.length, 6);
    const byId = Object.fromEntries(listed.map((t) => [t.id, t.priority]));
    assert.deepEqual(byId, {
      '2026-0001': null,       // 0 meant "never judged" -> stays unjudged
      '2026-0002': 'CRITICAL', // 1
      '2026-0003': 'LOW',      // 4
      '2026-0004': null,       // out of range
      '2026-0005': null,       // unknown word
      '2026-0006': null,       // key absent entirely
    });
    // The 0 card in particular is not laundered into a level. This is the shape
    // of all 166 live cards: mapping them to MEDIUM would invent 166 judgements.
    assert.equal(byId['2026-0001'], null);
    assert.notEqual(byId['2026-0001'], 'MEDIUM');

    // And they sort sanely: the mapped CRITICAL leads, the mapped LOW follows,
    // and the unset cards trail in id order. Two wrong answers are excluded by
    // this exact sequence — under the OLD ascending-integer compare the 0 card
    // would have LED, and under a 0->MEDIUM mapping it would sit ahead of LOW.
    assert.deepEqual(listed.map((t) => t.id), [
      '2026-0002', '2026-0003', '2026-0001', '2026-0004', '2026-0005', '2026-0006',
    ]);
    const order = listed.map((t) => t.id);
    assert.ok(order.indexOf('2026-0003') < order.indexOf('2026-0001'), 'legacy 0 must sort below a mapped LOW');
  } finally { await cleanup(root); }
});

test('touching a legacy card rewrites its priority in the new vocabulary', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    store.ensureProjectDirs('demo');
    seedRawCard('demo', 'todo', { id: '2026-0001', priorityLine: '2' });
    // What this pins: a legacy on-disk value does not survive being touched —
    // any unrelated mutation rewrites it in the new vocabulary, which is why
    // there is no migration script. The coercion that achieves it happens on
    // PARSE (the read side), so this test says nothing about serialize's own
    // normalisation; that invariant is owned by
    // tests/taskfile.test.mjs::"serialize omits the priority key entirely when
    // the card is unset" and its judged-level twin, which hand raw objects
    // straight to serialize and bypass parse.
    const r = await board.updateTask({ project: 'demo', id: '2026-0001', fields: { title: 'touched' } });
    assert.equal(r.ok, true);
    const raw = fs.readFileSync(path.join(stateDir('demo', 'todo'), '2026-0001.md'), 'utf8');
    assert.ok(raw.includes('\npriority: HIGH\n'), raw);
    assert.equal(raw.includes('priority: 2'), false, raw);
  } finally { await cleanup(root); }
});

test('touching a legacy 0 card drops the key rather than stamping a level on it', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    store.ensureProjectDirs('demo');
    seedRawCard('demo', 'todo', { id: '2026-0001', priorityLine: '0' });
    // Same migration-on-touch path as above, for the value 166 live cards hold.
    // The card must come out of the rewrite still unjudged: a build that wrote
    // `priority: MEDIUM` here would silently convert the entire backlog into
    // judgements on the next unrelated edit.
    const r = await board.updateTask({ project: 'demo', id: '2026-0001', fields: { title: 'touched' } });
    assert.equal(r.ok, true);
    const raw = fs.readFileSync(path.join(stateDir('demo', 'todo'), '2026-0001.md'), 'utf8');
    assert.equal(/^priority:/m.test(raw), false, raw);
    assert.equal((await board.readTask({ project: 'demo', id: '2026-0001' })).task.priority, null);
  } finally { await cleanup(root); }
});

// ---- acceptance (2026-0020) ------------------------------------------------
//
// update_task's fields.acceptance: three shapes ({ops:[...]}, {replace:[...]},
// null), four ops (add/remove/rename/done), single-pass pre-edit index
// resolution, and a closed refusal table. See docs/protocol.md's `acceptance`
// sub-bullet and .wiki/gotchas/acceptance-line-round-trip.md.

test('update_task acceptance: ops resolve against PRE-EDIT indices in a single pass', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a', 'b', 'c'] });
    // A walk-and-splice implementation deletes index 0 first, shifts, and then
    // "index 2" lands on the wrong (or an out-of-range) item.
    const r = await board.updateTask({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'remove', index: 0 }, { op: 'remove', index: 2 }] } },
    });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance, [{ text: 'b', done: false }]);
  } finally { await cleanup(root); }
});

test('update_task acceptance: a remove and a rename in one call each hit their pre-edit index', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a', 'b', 'c'] });
    const r = await board.updateTask({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'remove', index: 0 }, { op: 'rename', index: 1, text: 'B' }] } },
    });
    assert.equal(r.ok, true);
    // If rename resolved against the POST-remove list, pre-edit index 1 ('b')
    // would have already shifted to index 0 and 'c' would be renamed instead.
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance,
      [{ text: 'B', done: false }, { text: 'c', done: false }]);
  } finally { await cleanup(root); }
});

test('update_task acceptance: add appends after survivors, in ops order', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a', 'b'] });
    const r = await board.updateTask({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'add', text: 'c' }, { op: 'remove', index: 0 }, { op: 'add', text: 'd' }] } },
    });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance, [
      { text: 'b', done: false }, { text: 'c', done: false }, { text: 'd', done: false },
    ]);
  } finally { await cleanup(root); }
});

test('update_task acceptance: done:false unticks (kills a truthiness read)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a'] });
    await board.updateTask({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    assert.equal((await board.readTask({ project: 'demo', id })).task.acceptance[0].done, true);
    const r = await board.updateTask({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: false }] } } });
    assert.equal(r.ok, true);
    assert.equal((await board.readTask({ project: 'demo', id })).task.acceptance[0].done, false);
  } finally { await cleanup(root); }
});

test('update_task acceptance: done:true ticks and survives a re-read (serializer/parser path)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a', 'b'] });
    const r = await board.updateTask({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 1, done: true }] } } });
    assert.equal(r.ok, true);
    const raw = fs.readFileSync(path.join(stateDir('demo', 'triage'), `${id}.md`), 'utf8');
    assert.ok(raw.includes('- [ ] a'), raw);
    assert.ok(raw.includes('- [x] b'), raw);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance,
      [{ text: 'a', done: false }, { text: 'b', done: true }]);
  } finally { await cleanup(root); }
});

test('update_task acceptance: rename changes text and PRESERVES done', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a'] });
    await board.updateTask({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    const r = await board.updateTask({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'rename', index: 0, text: 'renamed' }] } } });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance, [{ text: 'renamed', done: true }]);
  } finally { await cleanup(root); }
});

// One test per refusal-table row. Each fires alongside a valid `title` change
// and asserts (a) ok:false, (b) code, (c) the EXACT reason string, (d) the
// card is UNCHANGED — old title AND old acceptance list. Clause (d) kills
// moving the acceptance resolve after the generic loop, or writing before
// validating (pattern copied from the refused-plan/refused-priority tests
// above).
async function expectAcceptanceRefusal(t, badValue, expectedReason) {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'orig', acceptance: ['x'] });
    const r = await board.updateTask({ project: 'demo', id, fields: { title: 'renamed', acceptance: badValue } });
    assert.equal(r.ok, false, `${JSON.stringify(badValue)} should refuse`);
    assert.equal(r.code, 'INVALID_STATE', JSON.stringify(badValue));
    assert.equal(r.reason, expectedReason, JSON.stringify(badValue));
    const after = (await board.readTask({ project: 'demo', id })).task;
    assert.equal(after.title, 'orig', `title leaked through for ${JSON.stringify(badValue)}`);
    assert.deepEqual(after.acceptance, [{ text: 'x', done: false }], `acceptance leaked through for ${JSON.stringify(badValue)}`);
  } finally { await cleanup(root); }
}

test('update_task acceptance refusal: not an object (array/string/number/boolean) names all three shapes', async (t) => {
  const reason = 'acceptance must be {ops:[…]}, {replace:[…]}, or null';
  // The array case is load-bearing: a caller who sends the natural `string[]`
  // guess (file_task's shape) must learn the right shape from this alone.
  for (const bad of [['x'], 'nope', 5, true]) await expectAcceptanceRefusal(t, bad, reason);
});

test('update_task acceptance refusal: both ops and replace present', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [], replace: [] }, 'acceptance takes exactly one of ops or replace');
});

test('update_task acceptance refusal: neither ops nor replace present', async (t) => {
  await expectAcceptanceRefusal(t, {}, 'acceptance takes exactly one of ops or replace');
});

test('update_task acceptance refusal: ops is not an array', async (t) => {
  await expectAcceptanceRefusal(t, { ops: 'nope' }, 'acceptance.ops must be an array');
});

test('update_task acceptance refusal: replace is not an array', async (t) => {
  await expectAcceptanceRefusal(t, { replace: 'nope' }, 'acceptance.replace must be an array of strings');
});

test('update_task acceptance refusal: an op is not an object', async (t) => {
  const reason = 'acceptance.ops[0]: each op must be an object with an op field';
  for (const bad of [null, 'x', 5, []]) await expectAcceptanceRefusal(t, { ops: [bad] }, reason);
});

test('update_task acceptance refusal: unknown op value names it and lists the four legal ops', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [{ op: 'bogus' }] }, 'acceptance.ops[0]: unknown op "bogus" (add, remove, rename, done)');
});

test('update_task acceptance refusal: non-integer index on remove/rename/done', async (t) => {
  const reason = 'acceptance.ops[0] (remove): index must be an integer';
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: '0' }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: 1.5 }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: NaN }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove' }] }, reason); // absent
});

test('update_task acceptance refusal: out-of-range index', async (t) => {
  // The card carries exactly 1 criterion, so length is 1 — index 1 (== length)
  // and -1 (negative) and 5 (well beyond) are all out of range.
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: -1 }] },
    'acceptance.ops[0] (remove): index -1 is out of range (list has 1 items)');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: 1 }] },
    'acceptance.ops[0] (remove): index 1 is out of range (list has 1 items)');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: 5 }] },
    'acceptance.ops[0] (remove): index 5 is out of range (list has 1 items)');
});

test('update_task acceptance refusal: non-boolean done', async (t) => {
  const reason = 'acceptance.ops[0] (done): done must be true or false';
  await expectAcceptanceRefusal(t, { ops: [{ op: 'done', index: 0, done: 'true' }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'done', index: 0, done: 1 }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'done', index: 0 }] }, reason); // absent
});

test('update_task acceptance refusal: non-string text on add/rename', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add', text: 42 }] }, 'acceptance.ops[0] (add): text must be a string');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add', text: null }] }, 'acceptance.ops[0] (add): text must be a string');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add' }] }, 'acceptance.ops[0] (add): text must be a string'); // absent
  await expectAcceptanceRefusal(t, { ops: [{ op: 'rename', index: 0, text: 42 }] }, 'acceptance.ops[0] (rename): text must be a string');
});

test('update_task acceptance refusal: text with an embedded newline on add/rename', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add', text: 'a\nb' }] }, 'acceptance.ops[0] (add): text must not contain a newline');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'rename', index: 0, text: 'a\rb' }] }, 'acceptance.ops[0] (rename): text must not contain a newline');
});

test('update_task acceptance refusal: text empty after trim on add/rename', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add', text: '   ' }] }, 'acceptance.ops[0] (add): text must be non-empty');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'rename', index: 0, text: '' }] }, 'acceptance.ops[0] (rename): text must be non-empty');
});

test('update_task acceptance refusal: the same three text failures inside replace', async (t) => {
  await expectAcceptanceRefusal(t, { replace: [42] }, 'acceptance.replace[0]: text must be a string');
  await expectAcceptanceRefusal(t, { replace: ['a\nb'] }, 'acceptance.replace[0]: text must not contain a newline');
  await expectAcceptanceRefusal(t, { replace: ['   '] }, 'acceptance.replace[0]: text must be non-empty');
});

test('update_task acceptance: replace preserves done by TEXT, not index', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a', 'b'] });
    await board.updateTask({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    const r = await board.updateTask({ project: 'demo', id, fields: { acceptance: { replace: ['b', 'a', 'c'] } } });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance, [
      { text: 'b', done: false }, { text: 'a', done: true }, { text: 'c', done: false },
    ]);
  } finally { await cleanup(root); }
});

test('update_task acceptance: replace trims, and the TRIMMED value is what matches', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a'] });
    await board.updateTask({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    const r = await board.updateTask({ project: 'demo', id, fields: { acceptance: { replace: ['  a  '] } } });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance, [{ text: 'a', done: true }]);
  } finally { await cleanup(root); }
});

test('update_task acceptance: replace with duplicate pre-edit texts — the FIRST occurrence wins', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['dup', 'dup'] });
    // Tick only the FIRST 'dup' (index 0); the second stays unticked.
    await board.updateTask({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    const r = await board.updateTask({ project: 'demo', id, fields: { acceptance: { replace: ['dup'] } } });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance, [{ text: 'dup', done: true }]);
  } finally { await cleanup(root); }
});

test('update_task acceptance: {replace: []} and null both clear the list', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a', 'b'] });
    const r1 = await board.updateTask({ project: 'demo', id, fields: { acceptance: { replace: [] } } });
    assert.equal(r1.ok, true);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance, []);

    await board.updateTask({ project: 'demo', id, fields: { acceptance: { replace: ['x'] } } });
    const r2 = await board.updateTask({ project: 'demo', id, fields: { acceptance: null } });
    assert.equal(r2.ok, true);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance, []);
  } finally { await cleanup(root); }
});

test('update_task acceptance: same-index ops are last-write-wins; remove is terminal', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a'] });
    const r1 = await board.updateTask({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'rename', index: 0, text: 'first' }, { op: 'rename', index: 0, text: 'second' }] } },
    });
    assert.equal(r1.ok, true);
    assert.deepEqual((await board.readTask({ project: 'demo', id })).task.acceptance, [{ text: 'second', done: false }]);

    const { id: id2 } = await board.fileTask({ project: 'demo', title: 't2', acceptance: ['a'] });
    const r2 = await board.updateTask({
      project: 'demo', id: id2,
      fields: { acceptance: { ops: [{ op: 'remove', index: 0 }, { op: 'rename', index: 0, text: 'ghost' }] } },
    });
    assert.equal(r2.ok, true); // remove-then-rename on the same index is NOT a refusal
    assert.deepEqual((await board.readTask({ project: 'demo', id: id2 })).task.acceptance, []);

    const { id: id3 } = await board.fileTask({ project: 'demo', title: 't3', acceptance: ['a'] });
    const r3 = await board.updateTask({
      project: 'demo', id: id3,
      fields: { acceptance: { ops: [{ op: 'rename', index: 0, text: 'ghost' }, { op: 'remove', index: 0 }] } },
    });
    assert.equal(r3.ok, true); // rename-then-remove: remove still wins regardless of order
    assert.deepEqual((await board.readTask({ project: 'demo', id: id3 })).task.acceptance, []);
  } finally { await cleanup(root); }
});

test('update_task acceptance: an edit writes NO logbook line', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 't', acceptance: ['a'] });
    const before = (await board.readTask({ project: 'demo', id })).task.logbook.length;
    const r = await board.updateTask({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'add', text: 'b' }, { op: 'done', index: 0, done: true }] } },
    });
    assert.equal(r.ok, true);
    const after = await board.readTask({ project: 'demo', id });
    // The edit must have actually landed — otherwise a no-op (e.g. acceptance
    // still being silently ignored) would trivially pass the logbook check too.
    assert.deepEqual(after.task.acceptance, [{ text: 'a', done: true }, { text: 'b', done: false }]);
    assert.equal(after.task.logbook.length, before);
  } finally { await cleanup(root); }
});
