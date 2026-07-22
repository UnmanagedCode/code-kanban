import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshRoot, cleanup } from './_helpers.mjs';
import * as store from '../src/store.js';
import { stateDir } from '../src/paths.js';

function baseTask(id) {
  return {
    id, title: 'A task: with colon', project: 'demo', epic: null, priority: 3,
    created: '2026-07-22T00:00:00.000Z', owner: null, depends_on: ['2026-0001', '2026-0002'],
    goal: 'Do the thing\nover two lines.',
    acceptance: [{ text: 'first', done: true }, { text: 'second', done: false }],
    logbook: ['2026-07-22T00:00:00.000Z · abcd1234 · filed'],
  };
}

test('writeTask/readTaskById round-trips all fields', async () => {
  const root = await freshRoot();
  try {
    store.ensureProjectDirs('demo');
    store.writeTask('demo', 'triage', baseTask('2026-0003'));
    const t = store.readTaskById('demo', '2026-0003');
    assert.equal(t.state, 'triage');
    assert.equal(t.title, 'A task: with colon');
    assert.equal(t.priority, 3);
    assert.deepEqual(t.depends_on, ['2026-0001', '2026-0002']);
    assert.match(t.goal, /over two lines/);
    assert.equal(t.acceptance.length, 2);
    assert.equal(t.acceptance[0].done, true);
    assert.equal(t.acceptance[1].done, false);
    assert.equal(t.logbook.length, 1);
  } finally { await cleanup(root); }
});

test('nextId is a gap-free project-wide sequence across states', async () => {
  const root = await freshRoot();
  try {
    store.ensureProjectDirs('demo');
    const year = new Date().getFullYear();
    assert.equal(store.nextId('demo'), `${year}-0001`);
    store.writeTask('demo', 'triage', baseTask(store.nextId('demo')));
    store.writeTask('demo', 'done', baseTask(store.nextId('demo')));
    assert.equal(store.nextId('demo'), `${year}-0003`);
  } finally { await cleanup(root); }
});

test('moveTask relocates the file and removes the old one', async () => {
  const root = await freshRoot();
  try {
    store.ensureProjectDirs('demo');
    const task = baseTask('2026-0007');
    store.writeTask('demo', 'todo', task);
    store.moveTask('demo', '2026-0007', 'todo', 'in-progress', task);
    assert.equal(fs.existsSync(`${stateDir('demo', 'todo')}/2026-0007.md`), false);
    assert.equal(fs.existsSync(`${stateDir('demo', 'in-progress')}/2026-0007.md`), true);
    assert.equal(store.findTaskFile('demo', '2026-0007').state, 'in-progress');
  } finally { await cleanup(root); }
});

test('atomicWrite leaves no .tmp- residue', async () => {
  const root = await freshRoot();
  try {
    store.ensureProjectDirs('demo');
    store.writeTask('demo', 'triage', baseTask('2026-0001'));
    const names = fs.readdirSync(stateDir('demo', 'triage'));
    assert.equal(names.some((n) => n.includes('.tmp-')), false);
  } finally { await cleanup(root); }
});
