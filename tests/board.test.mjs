import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshRoot, cleanup } from './_helpers.mjs';
import * as board from '../src/board.js';
import { _setProjectFetcher } from '../src/projects.js';

// Every test injects a fixed live-project list so validation never hits the net.
function useProjects(names) { _setProjectFetcher(async () => names); }

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

test('append_log resolves the in-progress card owned by the session', async () => {
  const root = await freshRoot();
  useProjects(['demo']);
  try {
    const { id } = await board.fileTask({ project: 'demo', title: 'owned' });
    await board.moveTask({ project: 'demo', id, to: 'todo' });
    await board.moveTask({ project: 'demo', id, to: 'in-progress', owner: 'worker-xyz' });

    // wrong / missing session -> refusal
    assert.equal((await board.appendLog({ project: 'demo', entry: 'hi', sessionId: 'other' })).code, 'TASK_UNKNOWN');
    assert.equal((await board.appendLog({ project: 'demo', entry: 'hi', sessionId: null })).code, 'TASK_UNKNOWN');

    const ok = await board.appendLog({ project: 'demo', entry: 'made progress', sessionId: 'worker-xyz' });
    assert.equal(ok.ok, true);
    const log = await board.readLog({ project: 'demo', id });
    assert.match(log.entries[0], /made progress/); // most-recent first
  } finally { await cleanup(root); }
});

test('append_log with two owned cards resolves to the most recently modified', async () => {
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
    await board.appendLog({ project: 'demo', entry: 'target-b', sessionId: 'w' });
    const logB = await board.readLog({ project: 'demo', id: b });
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
    await board.updateTask({ project: 'demo', id, fields: { title: 'renamed', priority: 5, bogus: 'x' } });
    const r = await board.readTask({ project: 'demo', id });
    assert.equal(r.task.title, 'renamed');
    assert.equal(r.task.priority, 5);
    assert.equal('bogus' in r.task, false);
  } finally { await cleanup(root); }
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
