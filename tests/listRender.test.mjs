import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCardList, renderEpicList } from '../src/listRender.js';

// Board-sort order: CRITICAL, then null-priority, then the backlog/todo rows.
// 2026-0004 carries an epic, 2026-0003 a depends_on, 2026-0001 an epic + plan,
// 2026-0002 none of the four — the omit-when-unset rule needs a row with
// nothing set to prove it never prints a bare `epic —`.
const ROWS = [
  { id: '2026-0004', state: 'triage', priority: 'CRITICAL', title: 'Fix the flaky lock', created: '2026-08-04T00:00:00.000Z', epic: 'auth', owner: null, depends_on: [], plan: null },
  { id: '2026-0002', state: 'triage', priority: null, title: 'Unjudged intake', created: '2026-08-02T00:00:00.000Z', epic: null, owner: null, depends_on: [], plan: null },
  { id: '2026-0003', state: 'backlog', priority: 'LOW', title: 'Parked idea', created: '2026-08-03T00:00:00.000Z', epic: null, owner: null, depends_on: ['2026-0002'], plan: null },
  { id: '2026-0001', state: 'todo', priority: 'HIGH', title: 'Ship the renderer', created: '2026-08-01T00:00:00.000Z', epic: 'auth', owner: null, depends_on: [], plan: 'board:2026-0001.md' },
];

const GOLDEN_CARDS =
  "CARDS demo — 4 shown · 2 done hidden (state:'done' to read them; includeDone:true for every lane)\n" +
  '\n' +
  '▸ triage (2)\n' +
  '    2026-0004  CRITICAL  Fix the flaky lock  2026-08-04  epic auth\n' +
  '    2026-0002  —         Unjudged intake     2026-08-02\n' +
  '▸ backlog (1)\n' +
  '    2026-0003  LOW       Parked idea         2026-08-03  deps 2026-0002\n' +
  '▸ todo (1)\n' +
  '    2026-0001  HIGH      Ship the renderer   2026-08-01  epic auth  plan board:2026-0001.md';

// A1: the whole rendering in one shot — header grammar, lane order, group
// counts, column alignment, `—` for unset priority, date-only `created`, and
// omit-when-empty (2026-0002's line ends after its date; the other three each
// carry a distinct tail fact). A mutant that prints `epic —` or drops a set
// field changes this string.
test('renderCardList: golden multi-lane listing', () => {
  const out = renderCardList(ROWS, { project: 'demo', doneHidden: 2 });
  assert.equal(out, GOLDEN_CARDS);
});

// A2: an empty lane (in-progress has zero cards here) emits NOTHING — kills a
// mutant that prints `▸ in-progress (none)`.
test('renderCardList: an empty lane is absent from the output entirely', () => {
  const out = renderCardList(ROWS, { project: 'demo', doneHidden: 2 });
  assert.equal(out.includes('in-progress'), false);
});

// A3: each header clause is independently gated.
test('renderCardList: header clauses are each independently gated', () => {
  assert.equal(
    renderCardList(ROWS, { project: 'demo', doneHidden: 0, state: 'done' }).split('\n')[0],
    'CARDS demo — 4 shown · state done',
  );
  assert.equal(
    renderCardList(ROWS, { project: 'demo', doneHidden: 0, everyLane: true }).split('\n')[0],
    'CARDS demo — 4 shown · every lane',
  );
  assert.equal(
    renderCardList(ROWS, { project: 'demo', doneHidden: 0, epic: 'auth' }).split('\n')[0],
    'CARDS demo — 4 shown · epic auth',
  );
  assert.equal(
    renderCardList(ROWS, { project: 'demo', doneHidden: 0 }).split('\n')[0],
    'CARDS demo — 4 shown',
  );
});

// A4: an all-done board must read as "0 shown · N done hidden", never as an
// empty board — header alone, no blank line, no trailing newline.
test('renderCardList: an empty shown-set with hidden cards is not an empty board', () => {
  const out = renderCardList([], { project: 'demo', doneHidden: 5 });
  assert.equal(out, "CARDS demo — 0 shown · 5 done hidden (state:'done' to read them; includeDone:true for every lane)");
});

// A5: a 120-char title carrying a raw newline is collapsed to one line and
// truncated to exactly 100 chars ending in `…` — a raw newline surviving
// would corrupt the whole listing (split a row across lines).
test('renderCardList: a title with an embedded newline renders on one line, truncated', () => {
  const rawTitle = `${'A'.repeat(50)}\n${'B'.repeat(69)}`;
  assert.equal(rawTitle.length, 120);
  const row = { id: '2026-0099', state: 'triage', priority: null, title: rawTitle, created: '2026-08-01T00:00:00.000Z', epic: null, owner: null, depends_on: [], plan: null };
  const out = renderCardList([row], { project: 'demo', doneHidden: 0 });
  assert.equal(out.includes('\n' + rawTitle), false); // never the raw multi-line form
  const titleCell = `${'A'.repeat(50)} ${'B'.repeat(48)}…`;
  assert.equal(titleCell.length, 100);
  assert.ok(out.includes(titleCell), out);
  // exactly one line per row: the number of newlines equals header+blank+group+row
  assert.equal(out.split('\n').length, 4);
});

const EPICS = [
  { slug: 'auth', title: 'Authentication rework', rollup: { triage: 1, backlog: 2, todo: 3, 'in-progress': 0, done: 4 }, projects: null },
  { slug: 'platform', title: '', rollup: { triage: 0, backlog: 0, todo: 1, 'in-progress': 2, done: 5 }, projects: ['web', 'api'] },
];

const GOLDEN_EPICS =
  'EPICS demo (2)\n' +
  '\n' +
  '▸ auth  Authentication rework\n' +
  '    triage 1  backlog 2  todo 3  in-progress 0  done 4\n' +
  '▸ platform  —  cross: web, api\n' +
  '    triage 0  backlog 0  todo 1  in-progress 2  done 5';

// A6: rollup label order, all five lanes always printed (including zero
// lanes — `done 0` must be distinguishable from "not computed"), `cross:`
// only for the cross-project epic, and `—` for an empty title.
test('renderEpicList: golden two-epic roster', () => {
  const out = renderEpicList(EPICS, { project: 'demo' });
  assert.equal(out, GOLDEN_EPICS);
});

// A7: empty spelling.
test('renderEpicList: zero epics renders the header alone', () => {
  assert.equal(renderEpicList([], { project: 'demo' }), 'EPICS demo (none)');
});
