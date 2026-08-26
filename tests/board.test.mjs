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
import { stateDir, plansDir, boardPlansDir, epicsDir, projectRepoDir } from '../src/paths.js';
import { localNodeId } from '../src/nodeId.js';

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

test('file_card -> triage, then full lifecycle to done', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await board.fileCard({ project: 'demo', title: 'Ship it', goal: 'because' });
    assert.equal(f.ok, true);
    const id = f.id;

    assert.equal((await board.moveCard({ project: 'demo', id, to: 'todo' })).ok, true);
    const mv = await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'sess-aaaa1111' });
    assert.deepEqual([mv.from, mv.to], ['todo', 'in-progress']);
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'done' })).ok, true);

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.state, 'done');
    assert.equal(r.card.owner, null); // cleared on leaving in-progress
    // filed + 3 moves
    assert.equal(r.card.logbook.length, 4);
  } finally { await cleanup(root); }
});

// 2026-0028 — the unknown-id refusal code on the two MUTATORS. readCard's arm
// is covered by the refusal-codes test below, but moveCard and updateCard were
// never called with a nonexistent id anywhere in the suite, so their
// fail('CARD_UNKNOWN', ...) sites were unpinned: renaming either back to the
// pre-rename TASK_UNKNOWN left the whole suite green. CARD_UNKNOWN is wire
// vocabulary that callers branch on (conventions/reporting.md tells workers to
// test for it by name), and it is vocabulary THIS card renamed, so a silent
// revert on a mutator is exactly the regression worth catching. Asserted on the
// code, not the reason prose — the code is the branchable half of the contract.
test('move_card on an unknown card id refuses CARD_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // A real project with a real card in it, so the refusal can only be about
    // the id — never PROJECT_UNKNOWN, and never an empty-board artefact.
    await board.fileCard({ project: 'demo', title: 'a real card' });
    const r = await board.moveCard({ project: 'demo', id: '2026-9999', to: 'backlog' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CARD_UNKNOWN');
    assert.match(r.reason, /2026-9999/);
  } finally { await cleanup(root); }
});

test('update_card on an unknown card id refuses CARD_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await board.fileCard({ project: 'demo', title: 'a real card' });
    const r = await board.updateCard({ project: 'demo', id: '2026-9999', fields: { title: 'x' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CARD_UNKNOWN');
    assert.match(r.reason, /2026-9999/);
  } finally { await cleanup(root); }
});

test('refusal codes: PROJECT_UNKNOWN, CARD_UNKNOWN, EPIC_UNKNOWN, INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal((await board.listCards({ project: 'ghost' })).code, 'PROJECT_UNKNOWN');
    assert.equal((await board.readCard({ project: 'demo', id: 'nope' })).code, 'CARD_UNKNOWN');
    assert.equal((await board.fileCard({ project: 'demo', title: 't', epic: 'missing' })).code, 'EPIC_UNKNOWN');

    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    // triage -> in-progress is illegal (must go via todo)
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'in-progress' })).code, 'INVALID_STATE');
    // triage -> triage (no-op) is illegal
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'triage' })).code, 'INVALID_STATE');
  } finally { await cleanup(root); }
});

test('corrective transitions are allowed (demote, abandon, reopen)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'backlog' })).ok, true); // demote
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'todo' })).ok, true);
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 's1' });
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'todo' })).ok, true); // abandon
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 's1' });
    await board.moveCard({ project: 'demo', id, to: 'done' });
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 's1' })).ok, true); // reopen
  } finally { await cleanup(root); }
});

test('log_card resolves the in-progress card owned by the session', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'owned' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'worker-xyz' });

    // wrong / missing session -> refusal
    assert.equal((await board.logCard({ project: 'demo', entry: 'hi', sessionId: 'other' })).code, 'CARD_UNKNOWN');
    assert.equal((await board.logCard({ project: 'demo', entry: 'hi', sessionId: null })).code, 'CARD_UNKNOWN');

    const ok = await board.logCard({ project: 'demo', entry: 'made progress', sessionId: 'worker-xyz' });
    assert.equal(ok.ok, true);
    const log = await board.readCardLog({ project: 'demo', id });
    assert.match(log.entries[0], /made progress/); // most-recent first
  } finally { await cleanup(root); }
});

test('log_card with two owned cards resolves to the most recently modified', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const a = (await board.fileCard({ project: 'demo', title: 'A' })).id;
    const b = (await board.fileCard({ project: 'demo', title: 'B' })).id;
    for (const id of [a, b]) {
      await board.moveCard({ project: 'demo', id, to: 'todo' });
      await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w' });
    }
    // Pin mtimes so b is deterministically the most-recently-modified, regardless
    // of how close together the moves above land on a coarse-mtime filesystem.
    stampMtime('demo', 'in-progress', a, 1_000_000);
    stampMtime('demo', 'in-progress', b, 2_000_000);
    await board.logCard({ project: 'demo', entry: 'target-b', sessionId: 'w' });
    const logB = await board.readCardLog({ project: 'demo', id: b });
    assert.match(logB.entries[0], /target-b/);
  } finally { await cleanup(root); }
});

test('log_card with id (conductor path) logs to the specified card, bypassing ownership', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'not owned by caller' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'worker-xyz' });

    // No sessionId at all, and it doesn't match the card's owner -- id bypasses that check.
    const ok = await board.logCard({ project: 'demo', id, entry: 'checked in', sessionId: null });
    assert.equal(ok.ok, true);
    const log = await board.readCardLog({ project: 'demo', id });
    // logLine's null-sessionId -> 'conductor' convention (same one move_card uses).
    assert.match(log.entries[0], /· conductor · checked in/);
  } finally { await cleanup(root); }
});

test('log_card with id but no project -> INVALID_STATE (ids are per-project)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w' });

    assert.equal(
      (await board.logCard({ id, entry: 'hi' })).code,
      'INVALID_STATE',
    );
  } finally { await cleanup(root); }
});

test('log_card with id targeting a non-existent card -> CARD_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal(
      (await board.logCard({ project: 'demo', id: 'ghost-0001', entry: 'hi' })).code,
      'CARD_UNKNOWN',
    );
  } finally { await cleanup(root); }
});

test('log_card with id targeting a card that is not in-progress -> CARD_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // filed into triage, never moved -> not in-progress
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    assert.equal(
      (await board.logCard({ project: 'demo', id, entry: 'hi' })).code,
      'CARD_UNKNOWN',
    );
  } finally { await cleanup(root); }
});

test('log_card with no id (worker path) is unaffected by the id path', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'owned' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'worker-xyz' });

    // Same session/ownership resolution as before -- explicitly passing id:undefined
    // (as a naive spread of {..., id: a.id} would when id is omitted) must not change behavior.
    const ok = await board.logCard({ project: 'demo', id: undefined, entry: 'still owner-based', sessionId: 'worker-xyz' });
    assert.equal(ok.ok, true);
    const log = await board.readCardLog({ project: 'demo', id });
    assert.match(log.entries[0], /still owner-based/);
  } finally { await cleanup(root); }
});

test('log_card with no project resolves the owned card in the only project', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'owned' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'worker-xyz' });

    const ok = await board.logCard({ entry: 'no project needed', sessionId: 'worker-xyz' });
    assert.equal(ok.ok, true);
    const log = await board.readCardLog({ project: 'demo', id });
    assert.match(log.entries[0], /no project needed/);
  } finally { await cleanup(root); }
});

test('log_card with no project scans across projects for the owned card', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'other']);
  try {
    const { id } = await board.fileCard({ project: 'other', title: 'owned elsewhere' });
    await board.moveCard({ project: 'other', id, to: 'todo' });
    await board.moveCard({ project: 'other', id, to: 'in-progress', owner: 'worker-xyz' });

    const ok = await board.logCard({ entry: 'found in other', sessionId: 'worker-xyz' });
    assert.equal(ok.ok, true);
    const log = await board.readCardLog({ project: 'other', id });
    assert.match(log.entries[0], /found in other/);
  } finally { await cleanup(root); }
});

test('log_card with no project ties-break by most-recently-modified across projects', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'other']);
  try {
    const a = (await board.fileCard({ project: 'demo', title: 'A' })).id;
    await board.moveCard({ project: 'demo', id: a, to: 'todo' });
    await board.moveCard({ project: 'demo', id: a, to: 'in-progress', owner: 'w' });

    const b = (await board.fileCard({ project: 'other', title: 'B' })).id;
    await board.moveCard({ project: 'other', id: b, to: 'todo' });
    await board.moveCard({ project: 'other', id: b, to: 'in-progress', owner: 'w' });

    // Pin mtimes so b is deterministically the most-recently-modified across
    // projects, regardless of real timing.
    stampMtime('demo', 'in-progress', a, 1_000_000);
    stampMtime('other', 'in-progress', b, 2_000_000);

    await board.logCard({ entry: 'target-b', sessionId: 'w' });
    const logB = await board.readCardLog({ project: 'other', id: b });
    assert.match(logB.entries[0], /target-b/);
    // a is untouched: still just its baseline filed + 2 moves, nothing appended.
    const logA = await board.readCardLog({ project: 'demo', id: a });
    assert.equal(logA.entries.length, 3);
    assert.doesNotMatch(logA.entries[0], /target-b/);
  } finally { await cleanup(root); }
});

test('log_card with an explicit project stays scoped to it (fast path unaffected by scan)', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'other']);
  try {
    const a = (await board.fileCard({ project: 'demo', title: 'A' })).id;
    await board.moveCard({ project: 'demo', id: a, to: 'todo' });
    await board.moveCard({ project: 'demo', id: a, to: 'in-progress', owner: 'w' });

    const b = (await board.fileCard({ project: 'other', title: 'B' })).id;
    await board.moveCard({ project: 'other', id: b, to: 'todo' });
    await board.moveCard({ project: 'other', id: b, to: 'in-progress', owner: 'w' });
    // b is the most-recently-modified overall, but an explicit project: 'demo' must target a.

    const ok = await board.logCard({ project: 'demo', entry: 'target-a', sessionId: 'w' });
    assert.equal(ok.ok, true);
    const logA = await board.readCardLog({ project: 'demo', id: a });
    assert.match(logA.entries[0], /target-a/);
    // b is untouched: still just its baseline filed + 2 moves, nothing appended.
    const logB = await board.readCardLog({ project: 'other', id: b });
    assert.equal(logB.entries.length, 3);
    assert.doesNotMatch(logB.entries[0], /target-a/);
  } finally { await cleanup(root); }
});

test('log_card with no project -> CARD_UNKNOWN when nothing is owned anywhere', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'other']);
  try {
    await board.fileCard({ project: 'demo', title: 'untouched' });
    assert.equal(
      (await board.logCard({ entry: 'hi', sessionId: 'nobody' })).code,
      'CARD_UNKNOWN',
    );
  } finally { await cleanup(root); }
});

test('log_card with no project and no sessionId -> CARD_UNKNOWN before any scan', async () => {
  const root = await freshRoot();
  let calls = 0;
  _setProjectFetcher(async () => { calls += 1; return ['demo', 'other']; });
  try {
    assert.equal(
      (await board.logCard({ entry: 'hi', sessionId: null })).code,
      'CARD_UNKNOWN',
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
    const t1 = (await board.fileCard({ project: 'demo', title: 'login', epic: 'auth' })).id;
    await board.fileCard({ project: 'demo', title: 'logout', epic: 'auth' });
    await board.moveCard({ project: 'demo', id: t1, to: 'todo' });

    const list = await board.listEpics({ project: 'demo' });
    assert.equal(list.epics[0].slug, 'auth');
    assert.equal(list.epics[0].rollup.triage, 1);
    assert.equal(list.epics[0].rollup.todo, 1);

    const re = await board.readEpic({ project: 'demo', slug: 'auth' });
    assert.equal(re.cards.length, 2);
    // `projects` is a CROSS-epic field. It must be absent, not present-holding-
    // undefined: the response is a field whitelist, and JSON.stringify drops an
    // undefined value, so an unconditional spread is invisible over the wire and
    // to the GUI — but it is still the whitelist quietly widening.
    assert.equal('projects' in re.epic, false);
    assert.equal((await board.readEpic({ project: 'demo', slug: 'ghost' })).code, 'EPIC_UNKNOWN');
  } finally { await cleanup(root); }
});

test('cross-project epic: aggregated rollup + cards span all member projects', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api']);
  try {
    assert.equal((await board.createEpic({ projects: ['web', 'api'], slug: 'platform', title: 'Platform' })).ok, true);
    // File cards under the same slug in BOTH member projects.
    const w = (await board.fileCard({ project: 'web', title: 'web ui', epic: 'platform' })).id;
    await board.fileCard({ project: 'api', title: 'api svc', epic: 'platform' });
    await board.moveCard({ project: 'web', id: w, to: 'todo' });

    // read_epic by slug alone aggregates across members; each task carries project.
    const re = await board.readEpic({ slug: 'platform' });
    assert.equal(re.ok, true);
    assert.deepEqual(re.epic.projects, ['web', 'api']);
    assert.equal(re.epic.rollup.triage, 1); // api task
    assert.equal(re.epic.rollup.todo, 1);   // web task
    assert.equal(re.cards.length, 2);
    assert.equal('tasks' in re, false); // 2026-0028: read_epic's list field is `cards` only
    assert.deepEqual(new Set(re.cards.map((t) => t.project)), new Set(['web', 'api']));

    // read_epic with a member project resolves the same cross-project epic.
    const viaProject = await board.readEpic({ project: 'web', slug: 'platform' });
    assert.equal(viaProject.cards.length, 2);

    // list_epics for a member surfaces it (flagged with projects) + aggregated rollup.
    const list = await board.listEpics({ project: 'api' });
    const pe = list.epics.find((e) => e.slug === 'platform');
    assert.deepEqual(pe.projects, ['web', 'api']);
    assert.equal(pe.rollup.triage, 1);
    assert.equal(pe.rollup.todo, 1);
  } finally { await cleanup(root); }
});

test('cross-project epic: fileCard allowed from a member, refused (EPIC_UNKNOWN) from a non-member', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api', 'infra']);
  try {
    await board.createEpic({ projects: ['web', 'api'], slug: 'platform', title: 'Platform' });
    assert.equal((await board.fileCard({ project: 'web', title: 't', epic: 'platform' })).ok, true);
    // infra is not a member, so the epic is not visible there — neither to
    // fileCard nor to a project-scoped read_epic.
    assert.equal((await board.fileCard({ project: 'infra', title: 't', epic: 'platform' })).code, 'EPIC_UNKNOWN');
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

test('read_card logTail keeps only the last N entries (0/1/2)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // Build a card with 4 logbook entries: filed + 3 moves.
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w' });
    await board.moveCard({ project: 'demo', id, to: 'done' });
    const full = (await board.readCard({ project: 'demo', id })).card.logbook;
    assert.equal(full.length, 4);

    // logTail:0 must yield zero entries (the slice(-0) trap).
    assert.equal((await board.readCard({ project: 'demo', id, logTail: 0 })).card.logbook.length, 0);
    const one = (await board.readCard({ project: 'demo', id, logTail: 1 })).card.logbook;
    assert.deepEqual(one, full.slice(-1));
    const two = (await board.readCard({ project: 'demo', id, logTail: 2 })).card.logbook;
    assert.deepEqual(two, full.slice(-2));
    // More than exist -> the whole log (the Math.max(0, …) clamp; a negative
    // start index would silently return a short from-the-end tail instead).
    assert.deepEqual((await board.readCard({ project: 'demo', id, logTail: 6 })).card.logbook, full);
  } finally { await cleanup(root); }
});

test('update_card applies whitelisted fields (incl. acceptance) and ignores others', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig', acceptance: ['a'] });
    await board.updateCard({
      project: 'demo', id,
      fields: { title: 'renamed', priority: 'CRITICAL', bogus: 'x', commit: 'sneaky', acceptance: { replace: ['b'] } },
    });
    const r = await board.readCard({ project: 'demo', id });
    // 2026-0028: the field is `card`, and the pre-rename `task` is really gone —
    // a dual-emitting shim would satisfy the positive assertion alone.
    assert.equal('task' in r, false);
    assert.equal(r.card.title, 'renamed');
    assert.equal(r.card.priority, 'CRITICAL');
    assert.equal('bogus' in r.card, false);
    assert.equal(r.card.commit, null); // commit is not in UPDATABLE — update_card can't set it
    assert.deepEqual(r.card.acceptance, [{ text: 'b', done: false }]); // acceptance joined UPDATABLE
  } finally { await cleanup(root); }
});

test('delete_card permanently removes the card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'to be deleted' });
    const del = await board.deleteCard({ project: 'demo', id });
    assert.equal(del.ok, true);
    assert.equal((await board.readCard({ project: 'demo', id })).code, 'CARD_UNKNOWN');
  } finally { await cleanup(root); }
});

test('delete_card with an unknown id -> CARD_UNKNOWN (soft refusal, not a throw)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal((await board.deleteCard({ project: 'demo', id: 'ghost-0001' })).code, 'CARD_UNKNOWN');
  } finally { await cleanup(root); }
});

test('delete_card with an unknown project -> PROJECT_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal((await board.deleteCard({ project: 'ghost', id: 'x' })).code, 'PROJECT_UNKNOWN');
  } finally { await cleanup(root); }
});

test('deleting the highest-numbered card does not let a later file_card reuse its id', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await board.fileCard({ project: 'demo', title: 'a' });
    const b = (await board.fileCard({ project: 'demo', title: 'b' })).id; // highest so far
    assert.equal((await board.deleteCard({ project: 'demo', id: b })).ok, true);
    const c = (await board.fileCard({ project: 'demo', title: 'c' })).id;
    assert.notEqual(c, b); // must not reuse the freed id
    assert.ok(c > b); // still strictly higher, not just different
  } finally { await cleanup(root); }
});

test('file_card with category "todo" lands directly in todo, skipping triage', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', category: 'todo' });
    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.state, 'todo');
  } finally { await cleanup(root); }
});

test('file_card with category "backlog" lands directly in backlog', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', category: 'backlog' });
    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.state, 'backlog');
  } finally { await cleanup(root); }
});

test('file_card with an illegal category -> INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    assert.equal((await board.fileCard({ project: 'demo', title: 't', category: 'done' })).code, 'INVALID_STATE');
    assert.equal((await board.fileCard({ project: 'demo', title: 't', category: 'bogus' })).code, 'INVALID_STATE');
  } finally { await cleanup(root); }
});

test('file_card with category omitted still defaults to triage', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.state, 'triage');
  } finally { await cleanup(root); }
});

test('moveCard auto-captures the OWNER WORKTREE HEAD sha, not the base checkout, on landing', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const base = initRepo(root, 'demo'); // base checkout — must NOT be read from
    const worktree = initRepo(root, 'demo_worktree_deadbeef'); // the owner's actual worktree
    assert.notEqual(base.sha, worktree.sha); // sanity: they really do differ
    useOwnerCwd('w-1', worktree.dir);

    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'done' })).ok, true);

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.commit, worktree.sha);
    assert.notEqual(r.card.commit, base.sha);
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveCard: an explicit commit param overrides auto-capture', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir); // resolvable, but should be ignored in favor of the explicit sha
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveCard({ project: 'demo', id, to: 'done', commit: 'deadbeefcafe' });

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.commit, 'deadbeefcafe');
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveCard: an explicit commit with an embedded newline is sanitized to its first line', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    // A frontmatter-injection attempt: a second "line" that looks like another
    // key. Only the clean first line may ever reach the task file.
    await board.moveCard({ project: 'demo', id, to: 'done', commit: 'cafe1234\nowner: injected' });

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.commit, 'cafe1234');
    assert.equal(r.card.owner, null); // the injected second line never took effect
  } finally { await cleanup(root); }
});

test('moveCard: an explicit commit with internal whitespace is rejected (falls back to auto-capture)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir);
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveCard({ project: 'demo', id, to: 'done', commit: 'not a real sha' });

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.commit, worktree.sha); // the dirty value was rejected, so auto-capture ran instead
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveCard: landing still succeeds with no commit when the owner\'s worktree cannot be resolved', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // No CONDUCTOR_URL is set and no instance fetcher is stubbed, so
    // ownerCwd() resolves to null regardless of the owner sessionId.
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    const mv = await board.moveCard({ project: 'demo', id, to: 'done' });
    assert.equal(mv.ok, true);

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.commit, null);
  } finally { await cleanup(root); }
});

test('moveCard: an instance-lookup failure (e.g. a timed-out fetch) degrades gracefully, no hang', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // Simulates what a timed-out/aborted fetch looks like to ownerCwd: the
    // fetcher rejects. moveCard must still resolve promptly with the move
    // applied and no commit stamped — never hang while holding the lock.
    _setInstanceFetcher(async () => { throw new Error('simulated timeout/abort'); });
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    const mv = await board.moveCard({ project: 'demo', id, to: 'done' });
    assert.equal(mv.ok, true);

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.commit, null);
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveCard: reopening (done -> in-progress) does not clobber the stamped commit', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir);
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveCard({ project: 'demo', id, to: 'done' });
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' })).ok, true); // reopen

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.commit, worktree.sha); // untouched by the reopen move
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveCard: re-landing after reopen captures a FRESH sha, overwriting the prior one', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir);
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveCard({ project: 'demo', id, to: 'done' });
    const firstCommit = (await board.readCard({ project: 'demo', id })).card.commit;
    assert.equal(firstCommit, worktree.sha);

    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' }); // reopen

    // A new commit lands on the same worktree branch before re-landing.
    const git = (...args) => execFileSync('git', ['-C', worktree.dir, ...args], { encoding: 'utf8' });
    fs.writeFileSync(path.join(worktree.dir, 'more.txt'), 'more work');
    git('add', 'more.txt');
    git('-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'more work');
    const freshSha = git('rev-parse', 'HEAD').trim();
    assert.notEqual(freshSha, firstCommit);

    assert.equal((await board.moveCard({ project: 'demo', id, to: 'done' })).ok, true); // re-land

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.commit, freshSha); // overwritten with the fresh sha
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('moveCard: re-landing preserves the prior commit when nothing resolves this time', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const worktree = initRepo(root, 'demo_worktree_deadbeef');
    useOwnerCwd('w-1', worktree.dir);
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' });
    await board.moveCard({ project: 'demo', id, to: 'done' });
    const firstCommit = (await board.readCard({ project: 'demo', id })).card.commit;

    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w-1' }); // reopen
    _setInstanceFetcher(async () => []); // the owner's worktree is no longer resolvable this time
    assert.equal((await board.moveCard({ project: 'demo', id, to: 'done' })).ok, true); // re-land, unresolvable

    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.commit, firstCommit); // preserved, not cleared
  } finally { _setInstanceFetcher(null); await cleanup(root); }
});

test('the per-project mutex serializes concurrent id assignment (no dupes)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => board.fileCard({ project: 'demo', title: `t${i}` })),
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

// Write a file under the BOARD-LEVEL plans/ dir — a CROSS-project epic's
// `board:` base, since it has no owning project.
function writeBoardLevelPlan(rel, body) {
  const file = path.join(boardPlansDir(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// The board's ingest destination for a card.
function ingestDest(project, id) { return path.join(plansDir(project), `${id}.md`); }

test('update_card sets a board: plan link; read_card returns plan_path', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'planned' });
    const file = writeBoardPlan('demo', 'p.md', '# the plan');
    const u = await board.updateCard({ project: 'demo', id, fields: { plan: 'board:p.md' } });
    assert.equal(u.ok, true);
    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.plan, 'board:p.md');
    assert.equal(r.plan_path, file);
    assert.equal(r.plan_body, undefined); // no body without includePlan
  } finally { await cleanup(root); }
});

test('update_card normalizes a bare plan path to board:', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'planned' });
    writeBoardPlan('demo', 'sub/p.md', 'plan');
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { plan: 'sub/p.md' } })).ok, true);
    // Stored WITH the explicit scheme, so every consumer reads one shape.
    assert.equal((await board.readCard({ project: 'demo', id })).card.plan, 'board:sub/p.md');
  } finally { await cleanup(root); }
});

test('update_card plan pointing at a missing file -> PLAN_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: 'board:nope.md' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.equal((await board.readCard({ project: 'demo', id })).card.plan, null); // nothing stored
  } finally { await cleanup(root); }
});

test('update_card plan pointing at a DIRECTORY -> PLAN_UNKNOWN (must be a regular file)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    fs.mkdirSync(path.join(plansDir('demo'), 'adir'), { recursive: true });
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { plan: 'adir' } })).code, 'PLAN_UNKNOWN');
  } finally { await cleanup(root); }
});

test('update_card plan via a symlink out of plans/ -> PLAN_UNKNOWN (no arbitrary-file read)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    fs.mkdirSync(plansDir('demo'), { recursive: true });
    fs.symlinkSync(secret, path.join(plansDir('demo'), 'escape.md'));
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: 'board:escape.md' } });
    assert.equal(r.code, 'PLAN_UNKNOWN'); // statSync follows the link, the realpath check catches it
  } finally { await cleanup(root); }
});

// NO LOCATION SNIFFING: an absolute path INSIDE plans/ is copied like any other
// source, rather than being normalised back to a board: pointer at itself.
test('update_card plan: an absolute path inside plans/ is copied like any other source', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const abs = writeBoardPlan('demo', 'p.md', 'the p.md plan');
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: abs } });
    assert.equal(r.ok, true);
    assert.equal(r.plan, `board:${id}.md`);
    assert.equal((await board.readCard({ project: 'demo', id })).card.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), 'the p.md plan');
    assert.equal(fs.readFileSync(abs, 'utf8'), 'the p.md plan'); // the source survives
  } finally { await cleanup(root); }
});

// OUTCOME test, not proof of the guard. Re-attaching plans/<id>.md by absolute
// path must succeed, store the link, and leave the content intact. It does NOT
// demonstrate that ingestPlanFile's self-copy guard is load-bearing: with the
// guard removed, libuv's same-inode short-circuit keeps this green too, so the
// assertions below pass either way (see the guard's comment in src/board.js).
test('update_card plan: an absolute path AT the destination succeeds with the content intact', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const abs = writeBoardPlan('demo', `${id}.md`, 'SELF');
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: abs } });
    assert.equal(r.ok, true);
    assert.equal(r.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'SELF'); // intact
    assert.equal((await board.readCard({ project: 'demo', id, includePlan: true })).plan_body, 'SELF');
  } finally { await cleanup(root); }
});

// The symlink form of the same OUTCOME: as strings source !== dest, so only the
// guard's realpath comparison recognises it — but, like the test above, this
// asserts the outcome and cannot prove the guard (libuv no-ops a same-inode copy
// regardless). Both mutants on the guard are waived expected survivors.
test('update_card plan: an absolute SYMLINK to the destination succeeds with the content intact', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const dest = writeBoardPlan('demo', `${id}.md`, 'SELF VIA SYMLINK');
    const link = path.join(src.dir, 'alias.md');
    fs.symlinkSync(dest, link);
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: link } });
    assert.equal(r.ok, true);
    assert.equal(r.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'SELF VIA SYMLINK'); // intact
  } finally { src.cleanup(); await cleanup(root); }
});

test('update_card plan with ../ traversal -> INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    // A real file one level ABOVE plans/ — reachable only if containment fails.
    fs.mkdirSync(plansDir('demo'), { recursive: true });
    fs.writeFileSync(path.join(plansDir('demo'), '..', 'outside.md'), 'nope');
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: '../outside.md' } });
    assert.equal(r.code, 'INVALID_STATE');
    assert.equal((await board.readCard({ project: 'demo', id })).card.plan, null);
  } finally { await cleanup(root); }
});

test('update_card plan: null clears the link', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    writeBoardPlan('demo', 'p.md', 'plan');
    await board.updateCard({ project: 'demo', id, fields: { plan: 'p.md' } });
    const cleared = await board.updateCard({ project: 'demo', id, fields: { plan: null } });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.plan, null); // reported, because fields.plan was in the call
    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.plan, null);
    assert.equal(r.plan_path, null);
  } finally { await cleanup(root); }
});

test('update_card repo: plan link fails while unmerged -> PLAN_UNKNOWN, passes once the file exists', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const link = 'repo:docs/plans/x.md';
    // Unmerged: nothing at that path in the BASE checkout yet.
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { plan: link } })).code, 'PLAN_UNKNOWN');
    const file = writeRepoPlan('demo', 'docs/plans/x.md', '# merged plan');
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { plan: link } })).ok, true);
    const r = await board.readCard({ project: 'demo', id, includePlan: true });
    assert.equal(r.card.plan, link);
    assert.equal(r.plan_path, file);
    assert.equal(r.plan_body, '# merged plan');
  } finally { await cleanup(root); }
});

// ---- plan ingest (a bare ABSOLUTE input is copied into the board) ----

test('update_card plan: an absolute path outside PROJECTS_ROOT is ingested as board:<id>.md', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'planned' });
    const source = src.write('deep-dive.md', '# the host plan\nbody\n');
    const u = await board.updateCard({ project: 'demo', id, fields: { plan: source } });
    assert.equal(u.ok, true);
    // Named from the CARD's id, not the source basename.
    assert.equal(u.plan, `board:${id}.md`);
    assert.equal((await board.readCard({ project: 'demo', id })).card.plan, `board:${id}.md`);
    assert.equal(fs.existsSync(path.join(plansDir('demo'), 'deep-dive.md')), false);
    // The copy is a real byte-for-byte copy, and readable through read_card.
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), '# the host plan\nbody\n');
    const r = await board.readCard({ project: 'demo', id, includePlan: true });
    assert.equal(r.plan_body, '# the host plan\nbody\n');
    assert.equal(r.plan_missing, false);
    // COPY, not move: the source is untouched.
    assert.equal(fs.existsSync(source), true);
    assert.equal(fs.readFileSync(source, 'utf8'), '# the host plan\nbody\n');
  } finally { src.cleanup(); await cleanup(root); }
});

test('update_card plan ingest creates plans/ when the project dir predates it', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    fs.rmSync(plansDir('demo'), { recursive: true, force: true }); // no plans/ at all
    assert.equal(fs.existsSync(plansDir('demo')), false);
    const source = src.write('p.md', 'made the dir');
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { plan: source } })).ok, true);
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), 'made the dir');
  } finally { src.cleanup(); await cleanup(root); }
});

test('update_card plan ingest of a revised plan OVERWRITES the board copy (no versioning)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const a = src.write('a.md', 'FIRST');
    const b = src.write('b.md', 'SECOND');
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { plan: a } })).ok, true);
    const second = await board.updateCard({ project: 'demo', id, fields: { plan: b } });
    assert.equal(second.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), 'SECOND');
    // Last write wins into ONE file — no suffixed sibling, no skip-if-exists.
    assert.deepEqual(fs.readdirSync(plansDir('demo')), [`${id}.md`]);
  } finally { src.cleanup(); await cleanup(root); }
});

test('update_card plan: a board: POINTER is never copied and never clobbers plans/<id>.md', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const other = writeBoardPlan('demo', 'other.md', 'X');
    const dest = writeBoardPlan('demo', `${id}.md`, 'SENTINEL');
    const u = await board.updateCard({ project: 'demo', id, fields: { plan: 'board:other.md' } });
    assert.equal(u.ok, true);
    assert.equal(u.plan, 'board:other.md');
    assert.equal((await board.readCard({ project: 'demo', id })).card.plan, 'board:other.md');
    assert.equal(fs.readFileSync(other, 'utf8'), 'X');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'SENTINEL'); // untouched
  } finally { await cleanup(root); }
});

test('update_card plan: a repo: POINTER is never copied into the board', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const repoFile = writeRepoPlan('demo', 'docs/plans/x.md', '# in-tree plan');
    const u = await board.updateCard({ project: 'demo', id, fields: { plan: 'repo:docs/plans/x.md' } });
    assert.equal(u.plan, 'repo:docs/plans/x.md');
    assert.equal(fs.readFileSync(repoFile, 'utf8'), '# in-tree plan');
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
  } finally { await cleanup(root); }
});

test('update_card plan: a BARE RELATIVE path is a pointer, not an ingest', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    writeBoardPlan('demo', 'p.md', 'plan');
    const u = await board.updateCard({ project: 'demo', id, fields: { plan: 'p.md' } });
    assert.equal(u.plan, 'board:p.md');
    assert.equal(fs.existsSync(ingestDest('demo', id)), false); // nothing copied
  } finally { await cleanup(root); }
});

// The real-world common case: the plan file lives in the worker's WORKTREE, which
// `repo:` (the base checkout) cannot reach. Ingest copies it — and the worktree
// dir is never mistaken for the project itself.
test('update_card plan: an absolute path inside a WORKTREE is copied in', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const wt = path.join(root, 'demo_worktree_ab12');
    fs.mkdirSync(wt, { recursive: true });
    const source = path.join(wt, 'plan.md');
    fs.writeFileSync(source, '# worktree plan');
    const u = await board.updateCard({ project: 'demo', id, fields: { plan: source } });
    assert.equal(u.plan, `board:${id}.md`);
    assert.equal(fs.readFileSync(ingestDest('demo', id), 'utf8'), '# worktree plan');
    assert.equal(fs.readFileSync(source, 'utf8'), '# worktree plan');
  } finally { await cleanup(root); }
});

test('update_card plan: a MISSING absolute source -> PLAN_UNKNOWN, card unchanged', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    writeBoardPlan('demo', 'p.md', 'the earlier plan');
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { plan: 'board:p.md' } })).ok, true);
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: path.join(src.dir, 'nope.md') } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PLAN_UNKNOWN');
    // Validation precedes mutation: the earlier link stands and nothing was written.
    assert.equal((await board.readCard({ project: 'demo', id })).card.plan, 'board:p.md');
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
  } finally { src.cleanup(); await cleanup(root); }
});

test('update_card plan: a DIRECTORY as the absolute source -> PLAN_UNKNOWN, refused by the stat', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const dir = path.join(src.dir, 'adir');
    fs.mkdirSync(dir, { recursive: true });
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: dir } });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    // The isFile() check refuses it, NOT a failed copy: without that check the
    // copy would refuse too (EISDIR), so pin which guard spoke.
    assert.match(r.reason, /not a regular file/);
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
  } finally { src.cleanup(); await cleanup(root); }
});

// The case the isFile() check is really load-bearing for: a source copyFileSync
// would happily accept, silently ingesting a bogus plan (an empty one, here).
test('update_card plan: a NON-REGULAR absolute source (character device) -> PLAN_UNKNOWN', async (t) => {
  if (!fs.existsSync('/dev/null')) return t.skip('no /dev/null on this platform');
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: '/dev/null' } });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.match(r.reason, /not a regular file/);
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
    assert.equal((await board.readCard({ project: 'demo', id })).card.plan, null);
  } finally { await cleanup(root); }
});

test('update_card plan: a DANGLING SYMLINK as the absolute source -> PLAN_UNKNOWN', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const link = path.join(src.dir, 'dangling.md');
    fs.symlinkSync(path.join(src.dir, 'gone.md'), link); // statSync follows -> ENOENT
    const r = await board.updateCard({ project: 'demo', id, fields: { plan: link } });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.equal(fs.existsSync(ingestDest('demo', id)), false);
  } finally { src.cleanup(); await cleanup(root); }
});

// ---- file_card's plan param (same three input forms, same validator) ----

test('file_card ingests an absolute plan into the CARD\'s own id', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const source = src.write('wake-plan.md', '# filed with a plan');
    const f = await board.fileCard({ project: 'demo', title: 't', plan: source });
    assert.equal(f.ok, true);
    assert.equal(f.plan, `board:${f.id}.md`);
    assert.equal(fs.readFileSync(ingestDest('demo', f.id), 'utf8'), '# filed with a plan');
    const r = await board.readCard({ project: 'demo', id: f.id, includePlan: true });
    assert.equal(r.card.plan, `board:${f.id}.md`);
    assert.equal(r.plan_body, '# filed with a plan');
  } finally { src.cleanup(); await cleanup(root); }
});

test('file_card with an unreadable absolute plan -> PLAN_UNKNOWN: no card, no id burned', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.fileCard({ project: 'demo', title: 't', plan: '/nope/definitely-not-here.md' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.equal(r.id, undefined);
    // Copy-then-write: nothing was created...
    assert.deepEqual((await board.listCards({ project: 'demo' })).cards, []);
    // ...and nextId consumed nothing, so the next filing gets the first id.
    const next = await board.fileCard({ project: 'demo', title: 'after' });
    assert.equal(next.id, `${new Date().getFullYear()}-0001`);
  } finally { await cleanup(root); }
});

test('file_card with a board: pointer at a missing file -> PLAN_UNKNOWN, no card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.fileCard({ project: 'demo', title: 't', plan: 'board:ghost.md' });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.deepEqual((await board.listCards({ project: 'demo' })).cards, []);
  } finally { await cleanup(root); }
});

test('file_card with a malformed plan -> INVALID_STATE before the lock, no card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.fileCard({ project: 'demo', title: 't', plan: 'board:/abs/p.md' });
    assert.equal(r.code, 'INVALID_STATE');
    assert.match(r.reason, /relative/);
    assert.deepEqual((await board.listCards({ project: 'demo' })).cards, []);
  } finally { await cleanup(root); }
});

test('file_card with a POINTER plan copies nothing', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    writeBoardPlan('demo', 'other.md', 'shared plan');
    const f = await board.fileCard({ project: 'demo', title: 't', plan: 'board:other.md' });
    assert.equal(f.plan, 'board:other.md');
    assert.equal(fs.existsSync(ingestDest('demo', f.id)), false);
    assert.deepEqual(fs.readdirSync(plansDir('demo')), ['other.md']);
  } finally { await cleanup(root); }
});

test('file_card without a plan reports no plan key (response shape unchanged)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const f = await board.fileCard({ project: 'demo', title: 't' });
    assert.equal('plan' in f, false);
    assert.equal((await board.readCard({ project: 'demo', id: f.id })).card.plan, null);
    const u = await board.updateCard({ project: 'demo', id: f.id, fields: { title: 'u' } });
    assert.equal('plan' in u, false); // only reported when fields.plan was in the call
  } finally { await cleanup(root); }
});

test('read_card includePlan returns the plan body', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    writeBoardPlan('demo', 'p.md', 'line one\nline two\n');
    await board.updateCard({ project: 'demo', id, fields: { plan: 'p.md' } });
    const r = await board.readCard({ project: 'demo', id, includePlan: true });
    assert.equal(r.plan_body, 'line one\nline two\n');
    assert.equal(r.plan_truncated, false);
    assert.equal(r.plan_missing, false);
  } finally { await cleanup(root); }
});

test('read_card includePlan sets plan_truncated over the cap', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const big = 'x'.repeat(65536 + 100);
    writeBoardPlan('demo', 'big.md', big);
    await board.updateCard({ project: 'demo', id, fields: { plan: 'big.md' } });
    const r = await board.readCard({ project: 'demo', id, includePlan: true });
    assert.equal(r.plan_truncated, true);
    assert.equal(r.plan_body.length, 65536); // cut at the cap, not the file size
    assert.equal(r.plan_missing, false);
  } finally { await cleanup(root); }
});

test('read_card includePlan at EXACTLY the cap is not truncated', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const exact = 'x'.repeat(65536); // PLAN_MAX_BYTES to the byte
    writeBoardPlan('demo', 'exact.md', exact);
    await board.updateCard({ project: 'demo', id, fields: { plan: 'exact.md' } });
    const r = await board.readCard({ project: 'demo', id, includePlan: true });
    // The cap is `size > PLAN_MAX_BYTES`, not `>=` — a file that exactly fills
    // it is returned whole and NOT flagged.
    assert.equal(r.plan_truncated, false);
    assert.equal(r.plan_body, exact);
  } finally { await cleanup(root); }
});

test('read_card includePlan on a missing plan file -> plan_body null + plan_missing (never a refusal)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const file = writeBoardPlan('demo', 'p.md', 'plan');
    await board.updateCard({ project: 'demo', id, fields: { plan: 'p.md' } });
    fs.rmSync(file); // e.g. the card synced in from a peer that holds the file
    const r = await board.readCard({ project: 'demo', id, includePlan: true });
    assert.equal(r.ok, true);
    assert.equal(r.plan_body, null);
    assert.equal(r.plan_missing, true);
    assert.equal(r.plan_path, file); // still resolved — a dead link, not an error
  } finally { await cleanup(root); }
});

test('read_card on an ungrammatical stored plan link -> plan_path null, no refusal', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    // Simulate a card synced from a newer peer: write the raw frontmatter value.
    const t = store.readCardById('demo', id);
    t.plan = 'weird:thing.md';
    store.writeCard('demo', 'triage', t);
    const r = await board.readCard({ project: 'demo', id, includePlan: true });
    assert.equal(r.ok, true);
    assert.equal(r.plan_path, null);
    assert.equal(r.plan_body, null);
    assert.equal(r.plan_missing, true);
  } finally { await cleanup(root); }
});

test('update_card owner off in-progress -> INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' }); // triage
    const r = await board.updateCard({ project: 'demo', id, fields: { owner: 'sess-2' } });
    assert.equal(r.code, 'INVALID_STATE');
    assert.equal((await board.readCard({ project: 'demo', id })).card.owner, null);
  } finally { await cleanup(root); }
});

test('update_card owner on an in-progress card logs owner <from> -> <to>, and null clears it', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'sess-plan' });

    assert.equal((await board.updateCard({ project: 'demo', id, fields: { owner: 'sess-impl' } })).ok, true);
    let r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.owner, 'sess-impl');
    assert.match(r.card.logbook.at(-1), /owner sess-plan -> sess-impl$/);
    assert.equal(r.card.state, 'in-progress'); // no lane move

    assert.equal((await board.updateCard({ project: 'demo', id, fields: { owner: null } })).ok, true);
    r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.owner, null);
    assert.match(r.card.logbook.at(-1), /owner sess-impl -> none$/);
  } finally { await cleanup(root); }
});

test('update_card owner with the same value logs nothing', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'sess-1' });
    const before = (await board.readCard({ project: 'demo', id })).card.logbook.length;
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { owner: 'sess-1' } })).ok, true);
    const after = (await board.readCard({ project: 'demo', id })).card.logbook;
    assert.equal(after.length, before);
    assert.equal(after.filter((l) => l.includes('owner ')).length, 0);
  } finally { await cleanup(root); }
});

test('update_card owner with whitespace or an empty value -> INVALID_STATE', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'sess-1' });
    for (const v of ['', 'a b', 'a\nowner: b', 7]) {
      assert.equal((await board.updateCard({ project: 'demo', id, fields: { owner: v } })).code, 'INVALID_STATE', `owner ${JSON.stringify(v)} refused`);
    }
    assert.equal((await board.readCard({ project: 'demo', id })).card.owner, 'sess-1'); // untouched
  } finally { await cleanup(root); }
});

test('update_card: a refused plan leaves the other fields unapplied (validation precedes mutation)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig' });
    const r = await board.updateCard({ project: 'demo', id, fields: { title: 'renamed', plan: 'board:ghost.md' } });
    assert.equal(r.code, 'PLAN_UNKNOWN');
    assert.equal((await board.readCard({ project: 'demo', id })).card.title, 'orig');
  } finally { await cleanup(root); }
});

test('delete_card removes a board: plan file and never a repo: one', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const a = await board.fileCard({ project: 'demo', title: 'board-planned' });
    const boardPlan = writeBoardPlan('demo', 'a.md', 'board plan');
    await board.updateCard({ project: 'demo', id: a.id, fields: { plan: 'board:a.md' } });

    const b = await board.fileCard({ project: 'demo', title: 'repo-planned' });
    const repoPlan = writeRepoPlan('demo', 'docs/b.md', 'repo plan');
    await board.updateCard({ project: 'demo', id: b.id, fields: { plan: 'repo:docs/b.md' } });

    assert.equal((await board.deleteCard({ project: 'demo', id: a.id })).ok, true);
    assert.equal(fs.existsSync(boardPlan), false); // the card's own plan file goes with it

    assert.equal((await board.deleteCard({ project: 'demo', id: b.id })).ok, true);
    assert.equal(fs.existsSync(repoPlan), true); // a source-tree file is NEVER touched
  } finally { await cleanup(root); }
});

test('delete_card with an already-missing board: plan file still succeeds', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't' });
    const file = writeBoardPlan('demo', 'p.md', 'plan');
    await board.updateCard({ project: 'demo', id, fields: { plan: 'p.md' } });
    fs.rmSync(file);
    assert.equal((await board.deleteCard({ project: 'demo', id })).ok, true);
  } finally { await cleanup(root); }
});

test('list_cards summary carries the plan link', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const a = await board.fileCard({ project: 'demo', title: 'planned' });
    await board.fileCard({ project: 'demo', title: 'unplanned' });
    writeBoardPlan('demo', 'p.md', 'plan');
    await board.updateCard({ project: 'demo', id: a.id, fields: { plan: 'p.md' } });
    const { cards } = await board.listCards({ project: 'demo' });
    const byId = Object.fromEntries(cards.map((t) => [t.id, t]));
    assert.equal(byId[a.id].plan, 'board:p.md');
    assert.equal(cards.filter((t) => !t.plan).length, 1);
  } finally { await cleanup(root); }
});

// ---- priority ----------------------------------------------------------
//
// The field is an enum (src/priority.js) plus a first-class UNSET state. These
// pin the things a mutant can quietly break: the rank ORDER (and specifically
// that unset sorts LAST), that unset round-trips through a clear, that a refusal
// never half-writes, and that a card written by the pre-enum build still loads
// and sorts.

// Write a card file straight into a column dir, bypassing board.js entirely —
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

test('file_card leaves priority UNSET when omitted — it never invents a level', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'no priority given' });
    const r = await board.readCard({ project: 'demo', id });
    assert.equal(r.card.priority, null);
    // Explicitly not laundered into the middle of the ladder, which is the
    // regression this card corrects.
    assert.notEqual(r.card.priority, 'MEDIUM');
    // And on DISK the key is ABSENT, not written as a word or a number.
    const raw = fs.readFileSync(path.join(stateDir('demo', 'triage'), `${id}.md`), 'utf8');
    assert.equal(/^priority:/m.test(raw), false, raw);
  } finally { await cleanup(root); }
});

test('file_card treats an explicit null priority as unset, same as omitting it', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'explicit null', priority: null });
    assert.equal((await board.readCard({ project: 'demo', id })).card.priority, null);
  } finally { await cleanup(root); }
});

test('file_card accepts an explicit priority and persists it', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    for (const level of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
      const { id } = await board.fileCard({ project: 'demo', title: level, priority: level });
      assert.equal((await board.readCard({ project: 'demo', id })).card.priority, level);
    }
  } finally { await cleanup(root); }
});

test('file_card refuses an unrecognised priority and files no card', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // Everything the DISK parser would tolerate must be refused here — that
    // split is the design (see .wiki/gotchas/priority-legacy-tolerance.md).
    // (null is absent from this list on purpose — it is the explicit "unset"
    // token, covered by its own test above.)
    for (const bad of ['URGENT', 'medium', 'Critical', '', 7, 2, 0, ['HIGH']]) {
      const r = await board.fileCard({ project: 'demo', title: 'nope', priority: bad });
      assert.equal(r.ok, false, `priority ${JSON.stringify(bad)} should refuse`);
      assert.equal(r.code, 'INVALID_STATE', JSON.stringify(bad));
    }
    // What this pins: a refusal performs NO store.writeCard. Nothing is listed,
    // and the next real card still gets -0001 — the id floor is bumped by
    // writeCard, not by store.nextId (which is a read), so a consumed id would
    // mean a card file had been written.
    assert.deepEqual((await board.listCards({ project: 'demo' })).cards, []);
    const { id } = await board.fileCard({ project: 'demo', title: 'first real card' });
    assert.equal(id.endsWith('-0001'), true, `a refusal wrote a card: ${id}`);
  } finally { await cleanup(root); }
});

test('update_card refuses a bad priority and leaves the WHOLE card untouched', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig', priority: 'LOW' });
    // A valid title rides along with the bad priority, and NEITHER lands. What
    // guarantees that is not the ordering of the checks but the single terminal
    // store.writeCard (board.js:417-420): `task` is an in-memory parse, so any
    // refusal path returns before anything is persisted. This pins that
    // property — a mutant that persists mid-loop lets the title through.
    const r = await board.updateCard({ project: 'demo', id, fields: { title: 'renamed', priority: 'URGENT' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_STATE');
    const after = (await board.readCard({ project: 'demo', id })).card;
    assert.equal(after.title, 'orig');
    assert.equal(after.priority, 'LOW');
  } finally { await cleanup(root); }
});

test('update_card refuses every non-level value except null', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'x', priority: 'HIGH' });
    // `undefined` is included: only an explicit null clears. A mutant widening
    // the clear token to any nullish value would let a dropped/typo'd field
    // silently erase a judgement.
    for (const bad of ['', 'high', 3, '3', undefined]) {
      const r = await board.updateCard({ project: 'demo', id, fields: { priority: bad } });
      assert.equal(r.ok, false, `priority ${JSON.stringify(bad)} should refuse`);
      assert.equal(r.code, 'INVALID_STATE', JSON.stringify(bad));
    }
    assert.equal((await board.readCard({ project: 'demo', id })).card.priority, 'HIGH');
  } finally { await cleanup(root); }
});

test('update_card clears priority back to unset with null, and it ROUND-TRIPS', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'judged then unjudged', priority: 'HIGH' });
    const cardPath = path.join(stateDir('demo', 'triage'), `${id}.md`);
    assert.ok(fs.readFileSync(cardPath, 'utf8').includes('\npriority: HIGH\n'));

    const cleared = await board.updateCard({ project: 'demo', id, fields: { priority: null } });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));

    // Three separate observations, because a clear can fail at three stages:
    // 1. the value the service layer returns,
    assert.equal((await board.readCard({ project: 'demo', id })).card.priority, null);
    // 2. what actually reached DISK (a clear that only lived in memory would
    //    pass step 1 and be lost on the next process),
    const raw = fs.readFileSync(cardPath, 'utf8');
    assert.equal(/^priority:/m.test(raw), false, raw);
    // 3. and that re-reading that file yields unset rather than a level — the
    //    round trip proper. It must not come back as MEDIUM.
    const reread = (await board.readCard({ project: 'demo', id })).card;
    assert.equal(reread.priority, null);
    assert.notEqual(reread.priority, 'MEDIUM');

    // And the card is still fully intact + re-judgeable afterwards.
    assert.equal(reread.title, 'judged then unjudged');
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { priority: 'LOW' } })).ok, true);
    assert.equal((await board.readCard({ project: 'demo', id })).card.priority, 'LOW');
  } finally { await cleanup(root); }
});

test('list_cards sorts CRITICAL first, LOW last, and UNSET after LOW', async () => {
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
    const unset = (await board.fileCard({ project: 'demo', title: 'u' })).id;
    const low = (await board.fileCard({ project: 'demo', title: 'l', priority: 'LOW' })).id;
    const med = (await board.fileCard({ project: 'demo', title: 'm', priority: 'MEDIUM' })).id;
    const high = (await board.fileCard({ project: 'demo', title: 'h', priority: 'HIGH' })).id;
    const crit = (await board.fileCard({ project: 'demo', title: 'c', priority: 'CRITICAL' })).id;
    // ids really do ascend in filing order, so the tiebreak genuinely opposes us
    assert.deepEqual([unset, low, med, high, crit].sort(), [unset, low, med, high, crit]);

    const ids = (await board.listCards({ project: 'demo' })).cards.map((t) => t.id);
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
    const lowTodo = (await board.fileCard({ project: 'demo', title: 'low/todo', priority: 'LOW', category: 'todo' })).id;
    const critDone = (await board.fileCard({ project: 'demo', title: 'crit/done', priority: 'CRITICAL', category: 'todo' })).id;
    await board.moveCard({ project: 'demo', id: critDone, to: 'in-progress' });
    await board.moveCard({ project: 'demo', id: critDone, to: 'done' });
    // Two UNSET cards in one column: ascending id decides.
    const u1 = (await board.fileCard({ project: 'demo', title: 'u1', category: 'todo' })).id;
    const u2 = (await board.fileCard({ project: 'demo', title: 'u2', category: 'todo' })).id;

    const ids = (await board.listCards({ project: 'demo' })).cards.map((t) => t.id);
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

    const listed = (await board.listCards({ project: 'demo' })).cards;
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
    // tests/cardfile.test.mjs::"serialize omits the priority key entirely when
    // the card is unset" and its judged-level twin, which hand raw objects
    // straight to serialize and bypass parse.
    const r = await board.updateCard({ project: 'demo', id: '2026-0001', fields: { title: 'touched' } });
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
    const r = await board.updateCard({ project: 'demo', id: '2026-0001', fields: { title: 'touched' } });
    assert.equal(r.ok, true);
    const raw = fs.readFileSync(path.join(stateDir('demo', 'todo'), '2026-0001.md'), 'utf8');
    assert.equal(/^priority:/m.test(raw), false, raw);
    assert.equal((await board.readCard({ project: 'demo', id: '2026-0001' })).card.priority, null);
  } finally { await cleanup(root); }
});

// ---- acceptance (2026-0020) ------------------------------------------------
//
// update_card's fields.acceptance: three shapes ({ops:[...]}, {replace:[...]},
// null), four ops (add/remove/rename/done), single-pass pre-edit index
// resolution, and a closed refusal table. See docs/protocol.md's `acceptance`
// sub-bullet and .wiki/gotchas/acceptance-line-round-trip.md.

test('update_card acceptance: ops resolve against PRE-EDIT indices in a single pass', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a', 'b', 'c'] });
    // A walk-and-splice implementation deletes index 0 first, shifts, and then
    // "index 2" lands on the wrong (or an out-of-range) item.
    const r = await board.updateCard({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'remove', index: 0 }, { op: 'remove', index: 2 }] } },
    });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance, [{ text: 'b', done: false }]);
  } finally { await cleanup(root); }
});

test('update_card acceptance: a remove and a rename in one call each hit their pre-edit index', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a', 'b', 'c'] });
    const r = await board.updateCard({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'remove', index: 0 }, { op: 'rename', index: 1, text: 'B' }] } },
    });
    assert.equal(r.ok, true);
    // If rename resolved against the POST-remove list, pre-edit index 1 ('b')
    // would have already shifted to index 0 and 'c' would be renamed instead.
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance,
      [{ text: 'B', done: false }, { text: 'c', done: false }]);
  } finally { await cleanup(root); }
});

test('update_card acceptance: add appends after survivors, in ops order', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a', 'b'] });
    const r = await board.updateCard({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'add', text: 'c' }, { op: 'remove', index: 0 }, { op: 'add', text: 'd' }] } },
    });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance, [
      { text: 'b', done: false }, { text: 'c', done: false }, { text: 'd', done: false },
    ]);
  } finally { await cleanup(root); }
});

test('update_card acceptance: done:false unticks (kills a truthiness read)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a'] });
    await board.updateCard({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    assert.equal((await board.readCard({ project: 'demo', id })).card.acceptance[0].done, true);
    const r = await board.updateCard({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: false }] } } });
    assert.equal(r.ok, true);
    assert.equal((await board.readCard({ project: 'demo', id })).card.acceptance[0].done, false);
  } finally { await cleanup(root); }
});

test('update_card acceptance: done:true ticks and survives a re-read (serializer/parser path)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a', 'b'] });
    const r = await board.updateCard({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 1, done: true }] } } });
    assert.equal(r.ok, true);
    const raw = fs.readFileSync(path.join(stateDir('demo', 'triage'), `${id}.md`), 'utf8');
    assert.ok(raw.includes('- [ ] a'), raw);
    assert.ok(raw.includes('- [x] b'), raw);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance,
      [{ text: 'a', done: false }, { text: 'b', done: true }]);
  } finally { await cleanup(root); }
});

test('update_card acceptance: rename changes text and PRESERVES done', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a'] });
    await board.updateCard({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    const r = await board.updateCard({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'rename', index: 0, text: 'renamed' }] } } });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance, [{ text: 'renamed', done: true }]);
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
    const { id } = await board.fileCard({ project: 'demo', title: 'orig', acceptance: ['x'] });
    const r = await board.updateCard({ project: 'demo', id, fields: { title: 'renamed', acceptance: badValue } });
    assert.equal(r.ok, false, `${JSON.stringify(badValue)} should refuse`);
    assert.equal(r.code, 'INVALID_STATE', JSON.stringify(badValue));
    assert.equal(r.reason, expectedReason, JSON.stringify(badValue));
    const after = (await board.readCard({ project: 'demo', id })).card;
    assert.equal(after.title, 'orig', `title leaked through for ${JSON.stringify(badValue)}`);
    assert.deepEqual(after.acceptance, [{ text: 'x', done: false }], `acceptance leaked through for ${JSON.stringify(badValue)}`);
  } finally { await cleanup(root); }
}

test('update_card acceptance refusal: not an object (array/string/number/boolean) names all three shapes', async (t) => {
  const reason = 'acceptance must be {ops:[…]}, {replace:[…]}, or null';
  // The array case is load-bearing: a caller who sends the natural `string[]`
  // guess (file_card's shape) must learn the right shape from this alone.
  for (const bad of [['x'], 'nope', 5, true]) await expectAcceptanceRefusal(t, bad, reason);
});

test('update_card acceptance refusal: both ops and replace present', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [], replace: [] }, 'acceptance takes exactly one of ops or replace');
});

test('update_card acceptance refusal: neither ops nor replace present', async (t) => {
  await expectAcceptanceRefusal(t, {}, 'acceptance takes exactly one of ops or replace');
});

test('update_card acceptance refusal: ops is not an array', async (t) => {
  await expectAcceptanceRefusal(t, { ops: 'nope' }, 'acceptance.ops must be an array');
});

test('update_card acceptance refusal: replace is not an array', async (t) => {
  await expectAcceptanceRefusal(t, { replace: 'nope' }, 'acceptance.replace must be an array of strings');
});

test('update_card acceptance refusal: an op is not an object', async (t) => {
  const reason = 'acceptance.ops[0]: each op must be an object with an op field';
  for (const bad of [null, 'x', 5, []]) await expectAcceptanceRefusal(t, { ops: [bad] }, reason);
});

test('update_card acceptance refusal: unknown op value names it and lists the four legal ops', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [{ op: 'bogus' }] }, 'acceptance.ops[0]: unknown op "bogus" (add, remove, rename, done)');
});

test('update_card acceptance refusal: non-integer index on remove/rename/done', async (t) => {
  const reason = 'acceptance.ops[0] (remove): index must be an integer';
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: '0' }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: 1.5 }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: NaN }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove' }] }, reason); // absent
});

test('update_card acceptance refusal: out-of-range index', async (t) => {
  // The card carries exactly 1 criterion, so length is 1 — index 1 (== length)
  // and -1 (negative) and 5 (well beyond) are all out of range.
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: -1 }] },
    'acceptance.ops[0] (remove): index -1 is out of range (list has 1 items)');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: 1 }] },
    'acceptance.ops[0] (remove): index 1 is out of range (list has 1 items)');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'remove', index: 5 }] },
    'acceptance.ops[0] (remove): index 5 is out of range (list has 1 items)');
});

test('update_card acceptance refusal: non-boolean done', async (t) => {
  const reason = 'acceptance.ops[0] (done): done must be true or false';
  await expectAcceptanceRefusal(t, { ops: [{ op: 'done', index: 0, done: 'true' }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'done', index: 0, done: 1 }] }, reason);
  await expectAcceptanceRefusal(t, { ops: [{ op: 'done', index: 0 }] }, reason); // absent
});

test('update_card acceptance refusal: non-string text on add/rename', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add', text: 42 }] }, 'acceptance.ops[0] (add): text must be a string');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add', text: null }] }, 'acceptance.ops[0] (add): text must be a string');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add' }] }, 'acceptance.ops[0] (add): text must be a string'); // absent
  await expectAcceptanceRefusal(t, { ops: [{ op: 'rename', index: 0, text: 42 }] }, 'acceptance.ops[0] (rename): text must be a string');
});

test('update_card acceptance refusal: text with an embedded newline on add/rename', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add', text: 'a\nb' }] }, 'acceptance.ops[0] (add): text must not contain a newline');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'rename', index: 0, text: 'a\rb' }] }, 'acceptance.ops[0] (rename): text must not contain a newline');
});

test('update_card acceptance refusal: text empty after trim on add/rename', async (t) => {
  await expectAcceptanceRefusal(t, { ops: [{ op: 'add', text: '   ' }] }, 'acceptance.ops[0] (add): text must be non-empty');
  await expectAcceptanceRefusal(t, { ops: [{ op: 'rename', index: 0, text: '' }] }, 'acceptance.ops[0] (rename): text must be non-empty');
});

test('update_card acceptance refusal: the same three text failures inside replace', async (t) => {
  await expectAcceptanceRefusal(t, { replace: [42] }, 'acceptance.replace[0]: text must be a string');
  await expectAcceptanceRefusal(t, { replace: ['a\nb'] }, 'acceptance.replace[0]: text must not contain a newline');
  await expectAcceptanceRefusal(t, { replace: ['   '] }, 'acceptance.replace[0]: text must be non-empty');
});

test('update_card acceptance: replace preserves done by TEXT, not index', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a', 'b'] });
    await board.updateCard({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    const r = await board.updateCard({ project: 'demo', id, fields: { acceptance: { replace: ['b', 'a', 'c'] } } });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance, [
      { text: 'b', done: false }, { text: 'a', done: true }, { text: 'c', done: false },
    ]);
  } finally { await cleanup(root); }
});

test('update_card acceptance: replace trims, and the TRIMMED value is what matches', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a'] });
    await board.updateCard({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    const r = await board.updateCard({ project: 'demo', id, fields: { acceptance: { replace: ['  a  '] } } });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance, [{ text: 'a', done: true }]);
  } finally { await cleanup(root); }
});

test('update_card acceptance: replace with duplicate pre-edit texts — the FIRST occurrence wins', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['dup', 'dup'] });
    // Tick only the FIRST 'dup' (index 0); the second stays unticked.
    await board.updateCard({ project: 'demo', id, fields: { acceptance: { ops: [{ op: 'done', index: 0, done: true }] } } });
    const r = await board.updateCard({ project: 'demo', id, fields: { acceptance: { replace: ['dup'] } } });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance, [{ text: 'dup', done: true }]);
  } finally { await cleanup(root); }
});

test('update_card acceptance: {replace: []} and null both clear the list', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a', 'b'] });
    const r1 = await board.updateCard({ project: 'demo', id, fields: { acceptance: { replace: [] } } });
    assert.equal(r1.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance, []);

    await board.updateCard({ project: 'demo', id, fields: { acceptance: { replace: ['x'] } } });
    const r2 = await board.updateCard({ project: 'demo', id, fields: { acceptance: null } });
    assert.equal(r2.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance, []);
  } finally { await cleanup(root); }
});

test('update_card acceptance: same-index ops are last-write-wins; remove is terminal', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a'] });
    const r1 = await board.updateCard({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'rename', index: 0, text: 'first' }, { op: 'rename', index: 0, text: 'second' }] } },
    });
    assert.equal(r1.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.acceptance, [{ text: 'second', done: false }]);

    const { id: id2 } = await board.fileCard({ project: 'demo', title: 't2', acceptance: ['a'] });
    const r2 = await board.updateCard({
      project: 'demo', id: id2,
      fields: { acceptance: { ops: [{ op: 'remove', index: 0 }, { op: 'rename', index: 0, text: 'ghost' }] } },
    });
    assert.equal(r2.ok, true); // remove-then-rename on the same index is NOT a refusal
    assert.deepEqual((await board.readCard({ project: 'demo', id: id2 })).card.acceptance, []);

    const { id: id3 } = await board.fileCard({ project: 'demo', title: 't3', acceptance: ['a'] });
    const r3 = await board.updateCard({
      project: 'demo', id: id3,
      fields: { acceptance: { ops: [{ op: 'rename', index: 0, text: 'ghost' }, { op: 'remove', index: 0 }] } },
    });
    assert.equal(r3.ok, true); // rename-then-remove: remove still wins regardless of order
    assert.deepEqual((await board.readCard({ project: 'demo', id: id3 })).card.acceptance, []);
  } finally { await cleanup(root); }
});

// ---- file_card / update_card list-shape refusals -----------------------
//
// A present, wrong-typed `acceptance`/`depends_on` used to be replaced by `[]`
// while file_card still returned {ok:true, id}. Every test below asserts the
// EXACT reason string, because the reason is the whole point: a caller with no
// signal is the failure being fixed.

// One test per refusal-table row. Asserts (a) ok:false, (b) code, (c) the EXACT
// reason, and (d) NO CARD WAS WRITTEN. Clause (d) is the one that kills "validate
// but write anyway" and "validate after store.writeCard".
async function expectFileRefusal(args, expectedReason) {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.fileCard({ project: 'demo', title: 't', ...args });
    assert.equal(r.ok, false, `${JSON.stringify(args)} should refuse`);
    assert.equal(r.code, 'INVALID_STATE', JSON.stringify(args));
    assert.equal(r.reason, expectedReason, JSON.stringify(args));
    assert.equal(r.id, undefined, 'a refusal must not hand back a card id');
    const listed = await board.listCards({ project: 'demo' });
    assert.equal(listed.cards.length, 0, `a card was written for ${JSON.stringify(args)}`);
  } finally { await cleanup(root); }
}

// Pins: a **present** non-array `acceptance` is `INVALID_STATE` and **no card is written**
test('file_card refuses a non-array acceptance instead of coercing it to []', async () => {
  const reason = 'acceptance must be an array of strings, or null';
  for (const bad of ['a\nb', { replace: ['a'] }, 5, true]) {
    await expectFileRefusal({ acceptance: bad }, reason);
  }
});

// Pins: a **present** non-array `depends_on` is `INVALID_STATE` and **no card is written**
test('file_card refuses a non-array depends_on the same way', async () => {
  const reason = 'depends_on must be an array of strings, or null';
  for (const bad of ['2026-0001', {}, 7]) {
    await expectFileRefusal({ depends_on: bad }, reason);
  }
});

// Pins: every index is validated, and a present non-string item is refused, not stored as the string `[object Object]`
test('file_card refuses a PRESENT non-string acceptance item, at any index', async () => {
  // Both index positions are load-bearing: the index-1 fixtures kill a
  // first-item-only check, the index-0 fixture kills a loop starting at i = 1,
  // and the exact `[i]` prefix kills an off-by-one in the prefix string.
  await expectFileRefusal({ acceptance: [{ text: 'oops' }, 'ok'] }, 'acceptance[0]: text must be a string');
  await expectFileRefusal({ acceptance: ['ok', 42] }, 'acceptance[1]: text must be a string');
  await expectFileRefusal({ acceptance: ['ok', null] }, 'acceptance[1]: text must be a string');
});

// Pins: every index is validated, and a present non-string item is refused, not stored as the string `[object Object]`
test('file_card refuses a PRESENT non-string depends_on item, at any index', async () => {
  await expectFileRefusal({ depends_on: [{ id: 'x' }, '2026-0001'] }, 'depends_on[0]: must be a string');
  await expectFileRefusal({ depends_on: ['2026-0001', 42] }, 'depends_on[1]: must be a string');
});

// Pins: filing-time items route through `cleanAcceptanceText`, not a private type check
test('file_card and update_card now apply the SAME criterion-text rules', async () => {
  // A bare `typeof !== 'string'` guard passes the non-string tests above but
  // fails here — this is the test that proves REUSE of the shared validator.
  await expectFileRefusal({ acceptance: ['a\nb'] }, 'acceptance[0]: text must not contain a newline');
  await expectFileRefusal({ acceptance: ['   '] }, 'acceptance[0]: text must be non-empty');
});

// Pins: trimming happens before persistence at filing time too
test('file_card stores the TRIMMED criterion text', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.fileCard({ project: 'demo', title: 't', acceptance: ['  a  '] });
    assert.equal(r.ok, true);
    // The assertion has to be on the BYTES: cardfile.parse trims every line, so
    // an untrimmed store round-trips back through readCard looking identical.
    // Only the file shows whether trimming happened before persistence.
    const raw = fs.readFileSync(path.join(stateDir('demo', 'triage'), `${r.id}.md`), 'utf8');
    assert.match(raw, /^- \[ \] a$/m);
    assert.deepEqual((await board.readCard({ project: 'demo', id: r.id })).card.acceptance,
      [{ text: 'a', done: false }]);
  } finally { await cleanup(root); }
});

// Pins: the refusal is scoped to a **present wrong-shaped** value; absent/null is not a break
test('file_card still accepts an OMITTED and an explicit-null acceptance/depends_on', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const omitted = await board.fileCard({ project: 'demo', title: 'a' });
    assert.equal(omitted.ok, true);
    const c1 = (await board.readCard({ project: 'demo', id: omitted.id })).card;
    assert.deepEqual(c1.acceptance, []);
    assert.deepEqual(c1.depends_on, []);

    const nulled = await board.fileCard({ project: 'demo', title: 'b', acceptance: null, depends_on: null });
    assert.equal(nulled.ok, true);
    const c2 = (await board.readCard({ project: 'demo', id: nulled.id })).card;
    assert.deepEqual(c2.acceptance, []);
    assert.deepEqual(c2.depends_on, []);
  } finally { await cleanup(root); }
});

// Pins: `update_card` stops silently wiping a dependency list; and it refuses **before** any mutation
test('update_card refuses a non-array depends_on and leaves the card UNCHANGED', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig', depends_on: ['2026-0001'] });
    const r = await board.updateCard({
      project: 'demo', id, fields: { title: 'renamed', depends_on: '2026-0002' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_STATE');
    assert.equal(r.reason, 'depends_on must be an array of strings, or null');
    const after = (await board.readCard({ project: 'demo', id })).card;
    assert.equal(after.title, 'orig');
    assert.deepEqual(after.depends_on, ['2026-0001']);
  } finally { await cleanup(root); }
});

// Pins: item validation reaches the second call site, not just `file_card`'s
test('update_card refuses a non-string depends_on item', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig', depends_on: ['2026-0001'] });
    const r = await board.updateCard({
      project: 'demo', id, fields: { title: 'renamed', depends_on: ['2026-0001', 9] },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_STATE');
    assert.equal(r.reason, 'depends_on[1]: must be a string');
    const after = (await board.readCard({ project: 'demo', id })).card;
    assert.equal(after.title, 'orig');
    assert.deepEqual(after.depends_on, ['2026-0001']);
  } finally { await cleanup(root); }
});

// Pins: the pre-existing clear behaviour survives the refusal
test('update_card depends_on: null still clears the list', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', depends_on: ['2026-0001'] });
    const r = await board.updateCard({ project: 'demo', id, fields: { depends_on: null } });
    assert.equal(r.ok, true);
    assert.deepEqual((await board.readCard({ project: 'demo', id })).card.depends_on, []);
  } finally { await cleanup(root); }
});

// Pins: the third coercion in the same object literal
test('file_card refuses a non-string goal', async () => {
  await expectFileRefusal({ goal: 42 }, 'goal must be a string, or null');
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.fileCard({ project: 'demo', title: 't', goal: null });
    assert.equal(r.ok, true);
    assert.equal((await board.readCard({ project: 'demo', id: r.id })).card.goal, '');
  } finally { await cleanup(root); }
});
// Pins: a PRESENT non-string `goal` is a returned refusal, never a TypeError escaping the file lock
test('update_card refuses a non-string goal instead of throwing out of the serializer', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig', goal: 'because' });
    for (const bad of [42, {}, [], true]) {
      const r = await board.updateCard({ project: 'demo', id, fields: { goal: bad } });
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, 'INVALID_STATE', JSON.stringify(bad));
      assert.equal(r.reason, 'goal must be a string, or null', JSON.stringify(bad));
      assert.equal((await board.readCard({ project: 'demo', id })).card.goal, 'because');
    }
  } finally { await cleanup(root); }
});

// Pins: `fields.title` is type- AND emptiness-checked, so it is neither stringified onto the
// one-line `title:` frontmatter key nor able to leave the card titleless
test('update_card refuses a non-string or empty title', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig' });
    for (const bad of [42, null, '', '   ', {}, ['x']]) {
      const r = await board.updateCard({ project: 'demo', id, fields: { title: bad } });
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, 'INVALID_STATE', JSON.stringify(bad));
      assert.equal(r.reason, 'title is required and must be a non-empty string', JSON.stringify(bad));
      const after = (await board.readCard({ project: 'demo', id })).card;
      assert.equal(after.title, 'orig', `title changed for ${JSON.stringify(bad)}`);
    }
  } finally { await cleanup(root); }
});

// ---- a newline in a title is frontmatter injection (2026-0033) ----------
//
// `title:` is ONE frontmatter line (cardfile.serialize) and cardfile.parse reads
// frontmatter line-by-line, so a newline does not truncate the title — the text
// after it becomes SIBLING keys. Both mutators refuse it through the shared
// checkTitle. Every fixture below kills a DISTINCT mutant, so the list stays whole:
//   'a\npriority: …' — the guard deleted outright (the card's own payload)
//   'a\nb'           — baseline
//   'a\rb'           — /[\n\r]/ narrowed to /\n/ or .includes('\n')
//   'a\r\nb'         — CRLF
//   'a\n' and '\na'  — the guard applied to value.trim() instead of the raw value
const NEWLINE_TITLES = ['a\npriority: CRITICAL\nowner: hijack', 'a\nb', 'a\rb', 'a\r\nb', 'a\n', '\na'];

// T1 — Pins: file_card refuses, with the exact reason, and writes NO card and hands back NO id
test('file_card refuses a title containing a newline or carriage return', async () => {
  for (const bad of NEWLINE_TITLES) {
    await expectFileRefusal({ title: bad }, 'title must not contain a newline');
  }
});

// T2 — Pins: update_card refuses the same values and the stored title is UNCHANGED
test('update_card refuses a title containing a newline and leaves the card UNCHANGED', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig' });
    for (const bad of NEWLINE_TITLES) {
      const r = await board.updateCard({ project: 'demo', id, fields: { title: bad } });
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, 'INVALID_STATE', JSON.stringify(bad));
      assert.equal(r.reason, 'title must not contain a newline', JSON.stringify(bad));
      const after = (await board.readCard({ project: 'demo', id })).card;
      assert.equal(after.title, 'orig', `title changed for ${JSON.stringify(bad)}`);
    }
  } finally { await cleanup(root); }
});

// T3 — Pins the END-TO-END consequence, on the raw bytes and through the reader: the injected
// lines never become frontmatter keys. `id`/`uid` are serialized ABOVE `title` and parse is
// last-wins, so unfixed they are overwritten OUTRIGHT — and `uid` is the cross-instance sync
// match key exposed by /api/sync/export. `priority`/`owner` are serialized below `title` but
// only when truthy, so unfixed they stick on a card that has neither set.
test('a newline title cannot inject frontmatter keys at either surface', async () => {
  const EVIL = 'a\npriority: CRITICAL\nowner: hijack\nuid: HIJACKED-UID\nid: 9999-9999';
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const filed = await board.fileCard({ project: 'demo', title: EVIL });
    assert.equal(filed.ok, false);
    assert.equal(filed.reason, 'title must not contain a newline');
    assert.equal((await board.listCards({ project: 'demo' })).cards.length, 0);

    const { id } = await board.fileCard({ project: 'demo', title: 'orig' });
    const uid = store.readCardById('demo', id).uid; // readCard strips uid; the raw parse keeps it
    const cardFile = path.join(stateDir('demo', 'triage'), `${id}.md`);

    const updated = await board.updateCard({ project: 'demo', id, fields: { title: EVIL } });
    assert.equal(updated.ok, false);
    assert.equal(updated.code, 'INVALID_STATE');
    assert.equal(updated.reason, 'title must not contain a newline');

    const raw = fs.readFileSync(cardFile, 'utf8');
    assert.equal(raw.match(/^title: /gm).length, 1);
    assert.doesNotMatch(raw, /^priority: /m);
    assert.doesNotMatch(raw, /^owner: /m);
    assert.match(raw, new RegExp(`^id: ${id}$`, 'm'));
    assert.deepEqual(raw.match(/^uid: .*$/gm), [`uid: ${uid}`]);

    const after = (await board.readCard({ project: 'demo', id })).card;
    assert.equal(after.title, 'orig');
    assert.equal(after.priority, null);
    assert.equal(after.owner, null);
  } finally { await cleanup(root); }
});

// T4 — Pins the ORDERING: the newline refusal lands above resolvePlanForSet, the ONLY prologue
// step with a side effect. A disk-only assertion cannot tell "validates early" from "validates
// late" (`task` is an in-memory parse), so the un-ingested plan file is the discriminator.
test("update_card's newline-title refusal precedes the plan ingest", async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    await board.createEpic({ project: 'demo', slug: 'ep', title: 'Epic' });
    const { id } = await board.fileCard({ project: 'demo', title: 'orig' });
    const cardFile = path.join(stateDir('demo', 'triage'), `${id}.md`);
    const before = fs.readFileSync(cardFile);
    const planSrc = src.write('outside.md', '# ingest me');

    const r = await board.updateCard({
      project: 'demo', id,
      fields: { title: 'a\npriority: CRITICAL', epic: 'ep', priority: 'CRITICAL', plan: planSrc },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_STATE');
    assert.equal(r.reason, 'title must not contain a newline');
    assert.deepEqual(fs.readFileSync(cardFile), before); // byte-identical: nothing applied
    assert.equal(fs.existsSync(ingestDest('demo', id)), false); // and nothing ingested
  } finally { src.cleanup(); await cleanup(root); }
});

// Pins: the refusal lands before the generic loop AND before resolvePlanForSet's ingest — the
// ONLY prologue step with a side effect. A disk-only assertion cannot tell "validates early"
// from "validates late" (`task` is an in-memory parse), so the un-ingested plan file is the
// discriminator. `title` precedes `goal` in UPDATABLE, so this is the loop-order case too.
test("update_card's title/goal refusal precedes every other resolution step", async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    await board.createEpic({ project: 'demo', slug: 'ep', title: 'Epic' });
    const { id } = await board.fileCard({ project: 'demo', title: 'orig', goal: 'because' });
    const cardFile = path.join(stateDir('demo', 'triage'), `${id}.md`);
    const before = fs.readFileSync(cardFile);
    const planSrc = src.write('outside.md', '# ingest me');

    const r = await board.updateCard({
      project: 'demo', id,
      fields: { title: 'renamed', epic: 'ep', priority: 'CRITICAL', plan: planSrc, goal: 42 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_STATE');
    assert.equal(r.reason, 'goal must be a string, or null');
    assert.deepEqual(fs.readFileSync(cardFile), before); // byte-identical: nothing applied
    assert.equal(fs.existsSync(ingestDest('demo', id)), false); // and nothing ingested
  } finally { src.cleanup(); await cleanup(root); }
});

// Pins: the refusal is scoped to a PRESENT wrong-typed value — the clear path and the ordinary
// rename are not breaks. (Regression guard: passes on the unfixed tree by design.)
test('update_card still accepts a string or null goal and an ordinary rename', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig', goal: 'because' });
    const read = async () => (await board.readCard({ project: 'demo', id })).card;

    assert.equal((await board.updateCard({ project: 'demo', id, fields: { goal: 'new' } })).ok, true);
    assert.equal((await read()).goal, 'new');
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { goal: null } })).ok, true);
    assert.equal((await read()).goal, '');
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { goal: 'again' } })).ok, true);
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { goal: '' } })).ok, true);
    assert.equal((await read()).goal, '');
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { title: 'renamed' } })).ok, true);
    assert.equal((await read()).title, 'renamed');
    // Omitting both leaves each untouched.
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { goal: 'kept' } })).ok, true);
    assert.equal((await board.updateCard({ project: 'demo', id, fields: { priority: 'LOW' } })).ok, true);
    const after = await read();
    assert.equal(after.title, 'renamed');
    assert.equal(after.goal, 'kept');
  } finally { await cleanup(root); }
});

// Pins: CARD_UNKNOWN outranks a title/goal shape refusal — the validators sit INSIDE the lock,
// after store.readCardById, matching how the epic/priority checks already behave. A "fail fast"
// hoist above the CARD_UNKNOWN block would flip these to INVALID_STATE.
test('update_card reports CARD_UNKNOWN, not INVALID_STATE, for a bad-shape field on an unknown id', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await board.fileCard({ project: 'demo', title: 'a real card' });
    // The newline title is here for the hoist mutant only — it PASSES either way (the id is
    // unknown on both trees), so it is not proof of the guard itself. T1/T2/T3 are.
    for (const fields of [{ goal: 42 }, { title: 42 }, { title: 'a\npriority: CRITICAL' }]) {
      const r = await board.updateCard({ project: 'demo', id: '2026-9999', fields });
      assert.equal(r.ok, false, JSON.stringify(fields));
      assert.equal(r.code, 'CARD_UNKNOWN', JSON.stringify(fields));
      assert.equal(r.reason, 'unknown card: 2026-9999', JSON.stringify(fields));
    }
  } finally { await cleanup(root); }
});

// Pins: the two mutators share ONE validator, so their refusal strings cannot drift
test('file_card and update_card word the title/goal refusal identically', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 'orig' });
    const filedTitle = await board.fileCard({ project: 'demo', title: 42 });
    const updatedTitle = await board.updateCard({ project: 'demo', id, fields: { title: 42 } });
    assert.equal(filedTitle.reason, updatedTitle.reason);
    assert.equal(updatedTitle.reason, 'title is required and must be a non-empty string');

    const filedNewline = await board.fileCard({ project: 'demo', title: 'a\npriority: CRITICAL' });
    const updatedNewline = await board.updateCard({
      project: 'demo', id, fields: { title: 'a\npriority: CRITICAL' },
    });
    assert.equal(filedNewline.reason, updatedNewline.reason);
    assert.equal(updatedNewline.reason, 'title must not contain a newline');

    const filedGoal = await board.fileCard({ project: 'demo', title: 't', goal: 42 });
    const updatedGoal = await board.updateCard({ project: 'demo', id, fields: { goal: 42 } });
    assert.equal(filedGoal.reason, updatedGoal.reason);
    assert.equal(updatedGoal.reason, 'goal must be a string, or null');
  } finally { await cleanup(root); }
});

test('update_card acceptance: an edit writes NO logbook line', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileCard({ project: 'demo', title: 't', acceptance: ['a'] });
    const before = (await board.readCard({ project: 'demo', id })).card.logbook.length;
    const r = await board.updateCard({
      project: 'demo', id,
      fields: { acceptance: { ops: [{ op: 'add', text: 'b' }, { op: 'done', index: 0, done: true }] } },
    });
    assert.equal(r.ok, true);
    const after = await board.readCard({ project: 'demo', id });
    // The edit must have actually landed — otherwise a no-op (e.g. acceptance
    // still being silently ignored) would trivially pass the logbook check too.
    assert.deepEqual(after.card.acceptance, [{ text: 'a', done: true }, { text: 'b', done: false }]);
    assert.equal(after.card.logbook.length, before);
  } finally { await cleanup(root); }
});

// ---- epic plan links + the epic logbook (2026-0025) -------------------
//
// An epic carries the same two things a card does: a typed `plan` LINK (the
// strategy behind the epic) and an append-only logbook (what landed, what got
// resequenced). Both go through the SAME helpers the card paths use, so each
// test below drives the EPIC call site specifically — a card-path test can't
// stand in for it.

test('create_epic re-upsert preserves an OMITTED goal; \'\'/null clear it (project AND cross epics)', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'web', 'api']);
  try {
    // --- a project-scoped epic ---
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth', goal: 'the original goal' });
    assert.equal((await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth v2' })).ok, true);
    let re = await board.readEpic({ project: 'demo', slug: 'auth' });
    assert.equal(re.epic.goal, 'the original goal'); // omitted -> preserved
    assert.equal(re.epic.title, 'Auth v2');          // title always overwrites
    // ...but an EXPLICIT clear must still clear: preservation must not swallow it.
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth v3', goal: '' });
    assert.equal((await board.readEpic({ project: 'demo', slug: 'auth' })).epic.goal, '');
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth v4', goal: 'a new goal' });
    assert.equal((await board.readEpic({ project: 'demo', slug: 'auth' })).epic.goal, 'a new goal');
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth v5', goal: null });
    assert.equal((await board.readEpic({ project: 'demo', slug: 'auth' })).epic.goal, '');

    // --- a cross-project epic: its own call site of the same rule ---
    await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat', goal: 'the cross goal' });
    await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat v2' });
    assert.equal((await board.readEpic({ slug: 'plat' })).epic.goal, 'the cross goal');
    await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat v3', goal: '' });
    assert.equal((await board.readEpic({ slug: 'plat' })).epic.goal, '');
  } finally { await cleanup(root); }
});

test('create_epic re-upsert preserves an OMITTED plan; plan:null clears it (project AND cross epics)', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'web', 'api']);
  try {
    // --- a project-scoped epic ---
    writeBoardPlan('demo', 'p.md', 'the strategy');
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth', plan: 'board:p.md' });
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth v2' }); // plan omitted
    assert.equal((await board.readEpic({ project: 'demo', slug: 'auth' })).epic.plan, 'board:p.md');
    const cleared = await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth v3', plan: null });
    assert.equal(cleared.plan, null);
    const after = await board.readEpic({ project: 'demo', slug: 'auth' });
    assert.equal(after.epic.plan, null);
    assert.equal(after.plan_path, null);

    // --- a cross-project epic ---
    writeBoardLevelPlan('x.md', 'the cross strategy');
    await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat', plan: 'board:x.md' });
    await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat v2' });
    assert.equal((await board.readEpic({ slug: 'plat' })).epic.plan, 'board:x.md');
    await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat v3', plan: null });
    assert.equal((await board.readEpic({ slug: 'plat' })).epic.plan, null);
  } finally { await cleanup(root); }
});

test('create_epic reports the stored plan link ONLY when plan was in the call (project AND cross)', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'web', 'api']);
  try {
    // --- a project-scoped epic ---
    const plain = await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth' });
    assert.equal('plan' in plain, false); // response shape unchanged for existing callers
    writeBoardPlan('demo', 'p.md', 'x');
    const set = await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth', plan: 'p.md' });
    assert.equal(set.plan, 'board:p.md'); // normalised: a bare path gained board:
    const cleared = await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth', plan: null });
    assert.equal('plan' in cleared, true); // null was in the call, so it is reported
    assert.equal(cleared.plan, null);

    // --- a cross-project epic: its own return statement, its own call site ---
    const xPlain = await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat' });
    assert.equal('plan' in xPlain, false);
    writeBoardLevelPlan('x.md', 'x');
    const xSet = await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat', plan: 'x.md' });
    assert.equal(xSet.plan, 'board:x.md');
    // ...and a re-upsert that OMITS plan (so the stored link is preserved) still
    // must not echo it — the field was not in the call.
    const xOmitted = await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat v2' });
    assert.equal('plan' in xOmitted, false);
    assert.equal((await board.readEpic({ slug: 'plat' })).epic.plan, 'board:x.md'); // still stored
    const xCleared = await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat', plan: null });
    assert.equal('plan' in xCleared, true);
    assert.equal(xCleared.plan, null);
  } finally { await cleanup(root); }
});

test('create_epic re-upsert preserves the epic\'s LOGBOOK (project AND cross epics)', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'web', 'api']);
  try {
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth' });
    await board.logEpic({ project: 'demo', slug: 'auth', entry: 'first card landed' });
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'Auth renamed', goal: 'g' });
    const log = await board.readEpic({ project: 'demo', slug: 'auth' });
    assert.equal(log.logbook_total, 1); // no caller can pass a logbook, so an upsert must never wipe it
    assert.match(log.epic.logbook[0], /first card landed/);

    await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat' });
    await board.logEpic({ slug: 'plat', entry: 'cross entry' });
    await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat renamed' });
    assert.equal((await board.readEpic({ slug: 'plat' })).logbook_total, 1);
  } finally { await cleanup(root); }
});

test('a project-scoped epic\'s board: link resolves under ITS project\'s plans/, not the board-level dir', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    // The file exists ONLY in the board-level dir: the pointer must NOT find it.
    writeBoardLevelPlan('p.md', 'board-level copy');
    const refused = await board.createEpic({ project: 'demo', slug: 'auth', title: 'A', plan: 'board:p.md' });
    assert.equal(refused.code, 'PLAN_UNKNOWN');
    // The same link resolves once the file is in the project's own plans/ dir.
    const file = writeBoardPlan('demo', 'p.md', 'project-level copy');
    assert.equal((await board.createEpic({ project: 'demo', slug: 'auth', title: 'A', plan: 'board:p.md' })).plan, 'board:p.md');
    const re = await board.readEpic({ project: 'demo', slug: 'auth', includePlan: true });
    assert.equal(re.plan_path, file);
    assert.equal(re.plan_body, 'project-level copy');
  } finally { await cleanup(root); }
});

test('a cross-project epic\'s plan lives in the BOARD-LEVEL plans/ dir, never a member\'s', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api']);
  const src = outsideSources();
  try {
    // Ingest: an absolute source is copied to <kanbanRoot>/plans/epic-<slug>.md.
    const source = src.write('strategy.md', '# the cross strategy');
    const c = await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat', plan: source });
    assert.equal(c.plan, 'board:epic-plat.md');
    const dest = path.join(boardPlansDir(), 'epic-plat.md');
    assert.equal(fs.readFileSync(dest, 'utf8'), '# the cross strategy');
    // Not in either member's plans/ — no fallback to the first member, no double write.
    for (const p of ['web', 'api']) {
      assert.equal(fs.existsSync(path.join(plansDir(p), 'epic-plat.md')), false, `${p} must hold no copy`);
    }
    const re = await board.readEpic({ slug: 'plat', includePlan: true });
    assert.equal(re.plan_path, dest);
    assert.equal(re.plan_body, '# the cross strategy');

    // A POINTER resolves against the same board-level base.
    const other = writeBoardLevelPlan('other.md', 'X');
    assert.equal((await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'Plat', plan: 'board:other.md' })).plan, 'board:other.md');
    assert.equal((await board.readEpic({ slug: 'plat' })).plan_path, other);
  } finally { src.cleanup(); await cleanup(root); }
});

// SLUG_RE admits a card-id-shaped slug, so `plans/<slug>.md` as the epic ingest
// destination would silently overwrite that card's own plan file. The `epic-`
// prefix (a card id can never start with it) is what keeps the two apart.
test('an epic ingest cannot clobber a card\'s plan file when the slug looks like a card id', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  const src = outsideSources();
  try {
    const f = await board.fileCard({ project: 'demo', title: 't', plan: src.write('card.md', 'THE CARD PLAN') });
    const cardDest = ingestDest('demo', f.id);
    assert.equal(f.plan, `board:${f.id}.md`);
    assert.equal(fs.readFileSync(cardDest, 'utf8'), 'THE CARD PLAN');

    const c = await board.createEpic({
      project: 'demo', slug: f.id, title: 'Colliding', plan: src.write('epic.md', 'THE EPIC PLAN'),
    });
    assert.equal(c.plan, `board:epic-${f.id}.md`);
    assert.equal(fs.readFileSync(cardDest, 'utf8'), 'THE CARD PLAN'); // byte-identical, untouched
    assert.equal(fs.readFileSync(path.join(plansDir('demo'), `epic-${f.id}.md`), 'utf8'), 'THE EPIC PLAN');
    assert.equal((await board.readCard({ project: 'demo', id: f.id, includePlan: true })).plan_body, 'THE CARD PLAN');
  } finally { src.cleanup(); await cleanup(root); }
});

test('repo: on a CROSS-project epic -> INVALID_STATE; the same link on a project-scoped epic resolves', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api']);
  try {
    const r = await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'P', plan: 'repo:docs/x.md' });
    assert.equal(r.code, 'INVALID_STATE');
    assert.match(r.reason, /owning project/);
    assert.equal((await board.readEpic({ slug: 'plat' })).code, 'EPIC_UNKNOWN'); // refused before any write

    const file = writeRepoPlan('web', 'docs/x.md', '# merged plan');
    const ok = await board.createEpic({ project: 'web', slug: 'local', title: 'L', plan: 'repo:docs/x.md' });
    assert.equal(ok.plan, 'repo:docs/x.md');
    assert.equal((await board.readEpic({ project: 'web', slug: 'local' })).plan_path, file);
  } finally { await cleanup(root); }
});

test('a symlink out of the BOARD-LEVEL plans/ dir is not readable through a cross-project epic', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api']);
  try {
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    fs.mkdirSync(boardPlansDir(), { recursive: true });
    fs.symlinkSync(secret, path.join(boardPlansDir(), 'escape.md'));
    // statSync follows the link; safePlanFile's realpath re-check catches it.
    const r = await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'P', plan: 'board:escape.md' });
    assert.equal(r.code, 'PLAN_UNKNOWN');
  } finally { await cleanup(root); }
});

test('read_epic returns plan_path with AND without includePlan, and null when unlinked', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const file = writeBoardPlan('demo', 'p.md', 'the plan');
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'A', plan: 'p.md' });
    const plain = await board.readEpic({ project: 'demo', slug: 'auth' });
    assert.equal(plain.plan_path, file);          // returned OUTSIDE the includePlan branch
    assert.equal(plain.plan_body, undefined);     // ...but no body without it
    assert.equal('plan_missing' in plain, false);
    const withBody = await board.readEpic({ project: 'demo', slug: 'auth', includePlan: true });
    assert.equal(withBody.plan_path, file);
    assert.equal(withBody.plan_body, 'the plan');

    await board.createEpic({ project: 'demo', slug: 'bare', title: 'B' });
    const bare = await board.readEpic({ project: 'demo', slug: 'bare', includePlan: true });
    assert.equal(bare.epic.plan, null);
    assert.equal(bare.plan_path, null);
    assert.equal(bare.plan_body, null);
    assert.equal(bare.plan_missing, false); // no link at all is not a MISSING file
  } finally { await cleanup(root); }
});

test('read_epic includePlan: truncation flag, and a deleted plan file -> plan_missing, never a refusal', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const file = writeBoardPlan('demo', 'p.md', 'line one\nline two\n');
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'A', plan: 'p.md' });
    let r = await board.readEpic({ project: 'demo', slug: 'auth', includePlan: true });
    assert.equal(r.plan_body, 'line one\nline two\n');
    assert.equal(r.plan_truncated, false);
    assert.equal(r.plan_missing, false);

    fs.rmSync(file); // e.g. the epic synced in from a peer that holds the file
    r = await board.readEpic({ project: 'demo', slug: 'auth', includePlan: true });
    assert.equal(r.ok, true); // a dead link is NEVER a refusal
    assert.equal(r.plan_body, null);
    assert.equal(r.plan_missing, true);
    assert.equal(r.plan_path, file); // still resolved

    writeBoardPlan('demo', 'big.md', 'x'.repeat(65536 + 100));
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'A', plan: 'big.md' });
    r = await board.readEpic({ project: 'demo', slug: 'auth', includePlan: true });
    assert.equal(r.plan_truncated, true);
    assert.equal(r.plan_body.length, 65536); // the same cap read_card applies
  } finally { await cleanup(root); }
});

test('read_epic logTail keeps only the last N logbook entries (0/1/2)', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'A' });
    for (const e of ['one', 'two', 'three']) await board.logEpic({ project: 'demo', slug: 'auth', entry: e });
    const full = (await board.readEpic({ project: 'demo', slug: 'auth' })).epic.logbook;
    assert.equal(full.length, 3);
    // logTail:0 must yield zero entries (the slice(-0) trap), as on read_card.
    assert.equal((await board.readEpic({ project: 'demo', slug: 'auth', logTail: 0 })).epic.logbook.length, 0);
    assert.deepEqual((await board.readEpic({ project: 'demo', slug: 'auth', logTail: 1 })).epic.logbook, full.slice(-1));
    assert.deepEqual((await board.readEpic({ project: 'demo', slug: 'auth', logTail: 2 })).epic.logbook, full.slice(-2));
    // Asking for MORE than exist returns the whole log. Without the Math.max(0, …)
    // clamp the start index goes negative and slice quietly returns a SHORT
    // from-the-end tail instead (3 entries, logTail:4 -> the last 1).
    assert.deepEqual((await board.readEpic({ project: 'demo', slug: 'auth', logTail: 4 })).epic.logbook, full);
  } finally { await cleanup(root); }
});

// B5 — logbook_total is the FULL length, computed BEFORE the logTail slice. It
// is what replaces read_card_log' `total` now that the epic arm is gone: with
// logTail:2 a conductor must still be able to tell 5 entries from 50.
// The 5-entry fixture is deliberately LONGER than every logTail exercised — a
// logbook whose length equals its logTail cannot tell logbook_total apart from
// "entries returned" — and the logTail:0 case additionally kills a mutant that
// computes the total after the slice.
test('read_epic logbook_total is the full length, before any logTail cap', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'A' });
    for (const e of ['a', 'b', 'c', 'd', 'e']) await board.logEpic({ project: 'demo', slug: 'auth', entry: e });
    for (const [logTail, shown] of [[2, 2], [0, 0]]) {
      const r = await board.readEpic({ project: 'demo', slug: 'auth', logTail });
      assert.equal(r.epic.logbook.length, shown, `logTail:${logTail} returns ${shown}`);
      assert.equal(r.logbook_total, 5, `logTail:${logTail} still reports the full total`);
    }
    const uncapped = await board.readEpic({ project: 'demo', slug: 'auth' });
    assert.equal(uncapped.epic.logbook.length, 5);
    assert.equal(uncapped.logbook_total, 5);
    // Top-level, not inside `epic` — `epic` mirrors the stored record, and
    // logbook_total is not a record field (same rule plan_path follows).
    assert.equal('logbook_total' in uncapped.epic, false);
  } finally { await cleanup(root); }
});

// B1 — logEpic appends a CONDUCTOR-attributed line, in chronological order.
// Kills a mutant that threads a sessionId through to logLine: an epic has no
// owner to credit. The `updated`/`node` bump is NOT asserted here — comparing
// two live nowIso() stamps at ms resolution is racy (the sequence regularly
// completes inside one millisecond). It is owned outright by
// 'logging to an epic bumps its updated/node version stamp (project AND cross)'
// below, which seeds a fixed peer stamp on disk instead.
test('logEpic appends a conductor-attributed line, chronologically ordered', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'A' });
    assert.equal((await board.logEpic({ project: 'demo', slug: 'auth', entry: 'first card landed' })).ok, true);
    // Even with a session id in hand there is no worker to credit — logEpic takes
    // no sessionId at all, so an extra key cannot leak into the attribution.
    assert.equal((await board.logEpic({ project: 'demo', slug: 'auth', entry: 'resequenced', sessionId: 'worker-xyz' })).ok, true);

    const r = await board.readEpic({ project: 'demo', slug: 'auth' });
    assert.equal(r.logbook_total, 2);
    // Chronological order, unlike read_card_log' most-recent-first card logbook
    // (.wiki/architecture/card-epic-tool-split.md).
    assert.match(r.epic.logbook[0], /· conductor · first card landed$/);
    assert.match(r.epic.logbook[1], /· conductor · resequenced$/);
    // An empty entry is refused, as on the card paths.
    assert.equal((await board.logEpic({ project: 'demo', slug: 'auth', entry: '  ' })).code, 'INVALID_STATE');
  } finally { await cleanup(root); }
});

// The decisive no-gate test: the two entries most worth having both happen when
// no card under the epic is in-progress.
test('logging to an epic with ZERO cards succeeds — an epic has no lane, so there is no gate', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'A' });
    assert.deepEqual((await board.listCards({ project: 'demo', epic: 'auth' })).cards, []);
    assert.equal((await board.logEpic({ project: 'demo', slug: 'auth', entry: 'resequenced before any card starts' })).ok, true);

    // ...and again once every card has LANDED (still nothing in-progress).
    const { id } = await board.fileCard({ project: 'demo', title: 't', epic: 'auth' });
    await board.moveCard({ project: 'demo', id, to: 'todo' });
    await board.moveCard({ project: 'demo', id, to: 'in-progress', owner: 'w' });
    await board.moveCard({ project: 'demo', id, to: 'done' });
    assert.equal((await board.logEpic({ project: 'demo', slug: 'auth', entry: 'retrospective' })).ok, true);
    assert.equal((await board.readEpic({ project: 'demo', slug: 'auth' })).logbook_total, 2);
    // ...and an unknown slug is still the one refusal on this path.
    assert.equal((await board.logEpic({ project: 'demo', slug: 'ghost', entry: 'x' })).code, 'EPIC_UNKNOWN');
  } finally { await cleanup(root); }
});

// B4 — readCardLog has NO epic arm. An `epic` key is now just an ignored extra
// argument, so the call falls through to the card path and refuses on a missing
// id — it must NOT return that epic's entries. Kills a mutant that removes the
// manifest param while leaving the arm in board.js.
test('readCardLog no longer has an epic arm — an epic slug does not read an epic', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    await board.createEpic({ project: 'demo', slug: 'auth', title: 'A' });
    await board.logEpic({ project: 'demo', slug: 'auth', entry: 'epic only' });
    const r = await board.readCardLog({ project: 'demo', epic: 'auth' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CARD_UNKNOWN');
    assert.equal(r.entries, undefined, 'must not hand back the epic logbook');
    // The card path itself is untouched.
    const { id } = await board.fileCard({ project: 'demo', title: 't', epic: 'auth' });
    assert.equal((await board.readCardLog({ project: 'demo', id })).total, 1); // filed
  } finally { await cleanup(root); }
});

// B2 — logEpic resolves through the SAME resolveEpic as readEpic. Kills an
// inlined resolver that drops the member fallback or the non-member guard.
test('logEpic resolves an epic exactly as readEpic does (member ok, non-member EPIC_UNKNOWN)', async () => {
  const root = await freshRoot();
  useProjects(['web', 'api', 'infra']);
  try {
    await board.createEpic({ projects: ['web', 'api'], slug: 'plat', title: 'P' });
    for (const [name, call] of [['log', (a) => board.logEpic({ ...a, entry: 'x' })], ['read', (a) => board.readEpic(a)]]) {
      assert.equal((await call({ project: 'web', slug: 'ghost' })).code, 'EPIC_UNKNOWN', `${name}: unknown slug`);
      assert.equal((await call({ slug: 'ghost' })).code, 'EPIC_UNKNOWN', `${name}: unknown slug, no project`);
      // infra is not a member, so the cross epic is not its epic.
      assert.equal((await call({ project: 'infra', slug: 'plat' })).code, 'EPIC_UNKNOWN', `${name}: non-member project`);
      assert.equal((await call({ project: 'ghost-project', slug: 'plat' })).code, 'PROJECT_UNKNOWN', `${name}: unknown project`);
    }
    // ...while a MEMBER project resolves the cross epic, as does the bare slug.
    assert.equal((await board.logEpic({ project: 'web', slug: 'plat', entry: 'ok' })).ok, true);
    assert.equal((await board.readEpic({ project: 'web', slug: 'plat' })).logbook_total, 1);
    assert.equal((await board.readEpic({ slug: 'plat' })).logbook_total, 1);
  } finally { await cleanup(root); }
});

test('epic logbook resolution precedence matches read_epic (project epic wins; a member falls through to cross)', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'web', 'api']);
  try {
    // The SAME slug as a project epic in demo and a cross epic over web+api.
    await board.createEpic({ project: 'demo', slug: 's', title: 'Project S' });
    await board.createEpic({ projects: ['web', 'api'], slug: 's', title: 'Cross S' });

    await board.logEpic({ project: 'demo', slug: 's', entry: 'to the project record' });
    await board.logEpic({ project: 'web', slug: 's', entry: 'to the cross record' });
    await board.logEpic({ slug: 's', entry: 'to the cross record by slug' });

    const p = await board.readEpic({ project: 'demo', slug: 's' });
    assert.equal(p.logbook_total, 1);
    assert.match(p.epic.logbook[0], /to the project record/);

    const x = await board.readEpic({ slug: 's' });
    assert.equal(x.logbook_total, 2);
    assert.match(x.epic.logbook[0], /to the cross record$/);
    assert.match(x.epic.logbook[1], /by slug/);
    // read_epic resolves each the same way.
    assert.equal((await board.readEpic({ project: 'demo', slug: 's' })).epic.title, 'Project S');
    assert.equal((await board.readEpic({ project: 'web', slug: 's' })).epic.title, 'Cross S');
    assert.equal((await board.readEpic({ slug: 's' })).epic.title, 'Cross S');
  } finally { await cleanup(root); }
});

// An edit that does not move `updated` is invisible to the LWW merge. Seeding a
// fixed peer stamp on disk makes the assertion deterministic — no
// same-millisecond race between two live timestamps.
test('logging to an epic bumps its updated/node version stamp (project AND cross)', async () => {
  const root = await freshRoot();
  useProjects(['demo', 'web', 'api']);
  try {
    store.ensureProjectDirs('demo');
    const stale = '2026-01-01T00:00:00.000Z';
    store.writeEpic('demo', { slug: 'auth', title: 'A', goal: '', created: stale, updated: stale, node: 'peer-node' });
    store.writeCrossEpic({ slug: 'plat', title: 'P', goal: '', projects: ['web', 'api'], created: stale, updated: stale, node: 'peer-node' });

    assert.equal((await board.logEpic({ project: 'demo', slug: 'auth', entry: 'landed' })).ok, true);
    assert.equal((await board.logEpic({ slug: 'plat', entry: 'landed' })).ok, true);

    const dump = await board.exportBoard({ scope: 'all' });
    const p = dump.projectEpics.demo.find((e) => e.slug === 'auth');
    const x = dump.crossEpics.find((e) => e.slug === 'plat');
    for (const [kind, e] of [['project', p], ['cross', x]]) {
      assert.ok(e.updated > stale, `${kind} epic updated must move past the peer stamp (got ${e.updated})`);
      assert.equal(e.node, localNodeId(), `${kind} epic node must become this machine's`);
      assert.equal(e.logbook.length, 1); // ...and the entry really landed
    }
  } finally { await cleanup(root); }
});

test('create_epic with a malformed plan -> INVALID_STATE before any lock; nothing is written', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const r = await board.createEpic({ project: 'demo', slug: 'auth', title: 'A', plan: 'board:/abs/p.md' });
    assert.equal(r.code, 'INVALID_STATE');
    assert.match(r.reason, /relative/);
    assert.equal((await board.readEpic({ project: 'demo', slug: 'auth' })).code, 'EPIC_UNKNOWN');
    assert.equal(fs.existsSync(path.join(epicsDir('demo'), 'auth.md')), false);
    // A grammatical pointer at a missing file refuses too, and still writes nothing.
    assert.equal((await board.createEpic({ project: 'demo', slug: 'auth', title: 'A', plan: 'board:ghost.md' })).code, 'PLAN_UNKNOWN');
    assert.equal((await board.readEpic({ project: 'demo', slug: 'auth' })).code, 'EPIC_UNKNOWN');
  } finally { await cleanup(root); }
});
