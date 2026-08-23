import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshRoot, cleanup } from './_helpers.mjs';
import * as store from '../src/store.js';
import { stateDir, plansDir, epicsDir, crossEpicsDir } from '../src/paths.js';

function baseTask(id) {
  return {
    id, title: 'A task: with colon', project: 'demo', epic: null, priority: 'HIGH',
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
    assert.equal(t.priority, 'HIGH');
    assert.deepEqual(t.depends_on, ['2026-0001', '2026-0002']);
    assert.match(t.goal, /over two lines/);
    assert.equal(t.acceptance.length, 2);
    assert.equal(t.acceptance[0].done, true);
    assert.equal(t.acceptance[1].done, false);
    assert.equal(t.logbook.length, 1);
  } finally { await cleanup(root); }
});

// This writes an ALREADY-TRIMMED text straight through store.writeTask,
// bypassing update_task's validator entirely — it does NOT exercise
// cleanAcceptanceText's trim-before-persist behavior (that's
// tests/board.test.mjs's "replace trims, and the TRIMMED value is what
// matches", which drives it through the real validator). What this pins is
// narrower: store/taskfile is a faithful pass-through — it introduces no
// padding on write and no trimming of its own on read — so a value the
// validator hands over already trimmed is what actually lands in the file
// (see .wiki/gotchas/acceptance-line-round-trip.md).
test('a renamed acceptance text is stored TRIMMED (no padding in the file) and reads back trimmed', async () => {
  const root = await freshRoot();
  try {
    store.ensureProjectDirs('demo');
    const id = '2026-0004';
    store.writeTask('demo', 'triage', { ...baseTask(id), id, acceptance: [{ text: 'trimmed value', done: true }] });
    const raw = fs.readFileSync(path.join(stateDir('demo', 'triage'), `${id}.md`), 'utf8');
    assert.ok(raw.includes('- [x] trimmed value\n'), raw); // exactly one separating space, no leading/trailing padding
    const t = store.readTaskById('demo', id);
    assert.deepEqual(t.acceptance, [{ text: 'trimmed value', done: true }]);
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

test('nextId does not regress after the highest-numbered card is deleted', async () => {
  const root = await freshRoot();
  try {
    store.ensureProjectDirs('demo');
    const year = new Date().getFullYear();
    store.writeTask('demo', 'triage', baseTask(store.nextId('demo'))); // 0001
    const id2 = store.nextId('demo');
    store.writeTask('demo', 'triage', baseTask(id2)); // 0002, the highest so far
    assert.equal(store.deleteTask('demo', id2), true);
    // Without the persisted floor this would reuse 0002 (the live scan's new
    // max, since 0001 is now the only file left).
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

// Characterization pins for the two epic codec PAIRS, written before the
// serializer/parser halves were factored out of writeEpic/readEpic and
// writeCrossEpic/readCrossEpic. They fix the pre-extraction behaviour of every
// field an epic file carries — including the `updated`/`node` sync stamp and its
// emitted-only-when-set rule — so the extraction is provably behaviour-neutral.
test('writeEpic/readEpic round-trips every field a project epic carries', async () => {
  const root = await freshRoot();
  try {
    store.ensureProjectDirs('demo');
    store.writeEpic('demo', {
      slug: 'auth', title: 'Auth: v2', goal: 'Sign-in\nover two lines.',
      created: '2026-07-22T00:00:00.000Z', updated: '2026-07-23T00:00:00.000Z', node: 'node-a',
    });
    assert.equal(store.epicExists('demo', 'auth'), true);
    const e = store.readEpic('demo', 'auth');
    assert.equal(e.slug, 'auth');
    assert.equal(e.title, 'Auth: v2'); // the value keeps its own colon
    assert.equal(e.project, 'demo');
    assert.match(e.goal, /over two lines/);
    assert.equal(e.created, '2026-07-22T00:00:00.000Z');
    assert.equal(e.updated, '2026-07-23T00:00:00.000Z');
    assert.equal(e.node, 'node-a');
    assert.deepEqual(store.listEpicSlugs('demo'), ['auth']);
    assert.equal(store.readEpic('demo', 'ghost'), null);
  } finally { await cleanup(root); }
});

test('both epic codecs round-trip the version stamp, and omit it entirely when unset', async () => {
  const root = await freshRoot();
  try {
    store.ensureProjectDirs('demo');
    store.writeCrossEpic({
      slug: 'platform', title: 'Platform', goal: '', projects: ['web', 'api'],
      created: '2026-07-22T00:00:00.000Z', updated: '2026-07-23T00:00:00.000Z', node: 'node-b',
    });
    const x = store.readCrossEpic('platform');
    assert.equal(x.updated, '2026-07-23T00:00:00.000Z');
    assert.equal(x.node, 'node-b');

    // A legacy epic (no stamp): the keys are absent from the FILE, and read back
    // as null — that absence is what sync's ensureEpicIdentity backfill detects.
    store.writeEpic('demo', { slug: 'legacy', title: 'Legacy', goal: 'g', created: '2026-01-01T00:00:00.000Z' });
    store.writeCrossEpic({ slug: 'xlegacy', title: 'XLegacy', goal: 'g', projects: ['web', 'api'], created: '2026-01-01T00:00:00.000Z' });
    const pRaw = fs.readFileSync(path.join(epicsDir('demo'), 'legacy.md'), 'utf8');
    const xRaw = fs.readFileSync(path.join(crossEpicsDir(), 'xlegacy.md'), 'utf8');
    for (const raw of [pRaw, xRaw]) {
      assert.equal(/^updated:/m.test(raw), false, raw);
      assert.equal(/^node:/m.test(raw), false, raw);
    }
    assert.equal(store.readEpic('demo', 'legacy').updated, null);
    assert.equal(store.readEpic('demo', 'legacy').node, null);
    assert.equal(store.readCrossEpic('xlegacy').updated, null);
    assert.equal(store.readCrossEpic('xlegacy').node, null);
  } finally { await cleanup(root); }
});

test('writeCrossEpic/readCrossEpic round-trips title, goal, and the projects list', async () => {
  const root = await freshRoot();
  try {
    store.writeCrossEpic({ slug: 'platform', title: 'Platform: v2', goal: 'Shared\ninfra work', projects: ['web', 'api'], created: '2026-07-22T00:00:00.000Z' });
    assert.equal(store.crossEpicExists('platform'), true);
    const x = store.readCrossEpic('platform');
    assert.equal(x.title, 'Platform: v2');
    assert.deepEqual(x.projects, ['web', 'api']);
    assert.match(x.goal, /infra work/);
    assert.equal(x.created, '2026-07-22T00:00:00.000Z');
    assert.deepEqual(store.listCrossEpicSlugs(), ['platform']);
    assert.equal(store.readCrossEpic('ghost'), null);
  } finally { await cleanup(root); }
});

test('ensureProjectDirs creates plans/ (the board: plan-link base)', async () => {
  const root = await freshRoot();
  try {
    store.ensureProjectDirs('demo');
    assert.equal(fs.existsSync(plansDir('demo')), true);
  } finally { await cleanup(root); }
});
