import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { freshRoot, cleanup } from './_helpers.mjs';
import * as board from '../src/board.js';
import { _setProjectFetcher } from '../src/projects.js';
import { _setInstanceFetcher } from '../src/ownerWorktree.js';

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
    // b was moved into in-progress last -> it is the most recently modified.
    await board.logProgress({ project: 'demo', entry: 'target-b', sessionId: 'w' });
    const logB = await board.readProgress({ project: 'demo', id: b });
    assert.match(logB.entries[0], /target-b/);
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
