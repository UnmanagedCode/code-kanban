import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  refusalReason, transitionsFrom, badgedPriority, laneCards, laneLabel, splitEpics, rollupPills,
  parseLogLine, epicOptions, priorityOptions, epicReadPath, cardsPath, cardReadPath, movePath,
  epicsPath, planFromEnvelope,
} from '../frontend/src/lib/board.ts';
import {
  splitList, newCardBody, editCardFields, epicCreateRequest, syncPullBody, syncSummaryText, ONE_MEMBER_ERROR,
} from '../frontend/src/lib/forms.ts';
import { api, ApiError } from '../frontend/src/lib/api.ts';

// The UI's decisions, as the pure modules under frontend/src/lib/ make them. The
// components only map this data onto elements; the Playwright harness covers that
// wiring, the rendering and the layout.

const META = {
  states: ['triage', 'backlog', 'todo', 'in-progress', 'done'],
  transitions: ['triage>backlog', 'triage>todo', 'todo>in-progress', 'in-progress>done', 'in-progress>todo'],
  priorities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
};

test('refusalReason: reason, else code, else "refused", only for {ok:false}', () => {
  assert.equal(refusalReason({ ok: false, code: 'X', reason: 'why' }), 'why');
  assert.equal(refusalReason({ ok: false, code: 'X' }), 'X');
  assert.equal(refusalReason({ ok: false }), 'refused');
  assert.equal(refusalReason({ ok: true }), null);
  assert.equal(refusalReason({}), null);
  assert.equal(refusalReason(null), null);
});

test('transitionsFrom: the targets meta.transitions lists for that source, in order', () => {
  assert.deepEqual(transitionsFrom(META, 'triage'), ['backlog', 'todo']);
  assert.deepEqual(transitionsFrom(META, 'in-progress'), ['done', 'todo']);
  assert.deepEqual(transitionsFrom(META, 'done'), []);
  // A prefix of another state is not that state.
  assert.deepEqual(transitionsFrom({ ...META, transitions: ['todo-x>done', 'todo>done'] }, 'todo'), ['done']);
});

test('badgedPriority: every judged level badges, unset stays bare', () => {
  for (const p of META.priorities) assert.equal(badgedPriority(p), true, p);
  for (const p of [null, undefined, '', 0]) assert.equal(badgedPriority(p), false, String(p));
});

test('laneCards: the lane in server order, and the plan filter keeps only linked cards', () => {
  const cards = [
    { id: '3', title: 'c', state: 'todo', plan: 'board:p.md' },
    { id: '1', title: 'a', state: 'done' },
    { id: '2', title: 'b', state: 'todo' },
    { id: '4', title: 'd', state: 'todo', plan: '' },
  ];
  assert.deepEqual(laneCards(cards, 'todo', false).map((c) => c.id), ['3', '2', '4']);
  assert.deepEqual(laneCards(cards, 'todo', true).map((c) => c.id), ['3']);
  assert.deepEqual(laneCards(cards, 'backlog', false), []);
});

test('laneLabel: dashes become spaces, first letter capitalised', () => {
  assert.equal(laneLabel('in-progress'), 'In progress');
  assert.equal(laneLabel('triage'), 'Triage');
});

test("splitEpics: by the server's completed flag, each half in server order", () => {
  const epics = [
    { slug: 'a', title: 'A', completed: false, rollup: { done: 3 } },
    { slug: 'b', title: 'B', completed: true },
    { slug: 'c', title: 'C' },
    { slug: 'd', title: 'D', completed: true, rollup: { todo: 1 } },
  ];
  const { active, completed } = splitEpics(epics);
  assert.deepEqual(active.map((e) => e.slug), ['a', 'c']);
  assert.deepEqual(completed.map((e) => e.slug), ['b', 'd']);
});

test('rollupPills: one per meta state in order, labelled, zero counted and flagged', () => {
  assert.deepEqual(rollupPills(META.states, { todo: 2, done: 0 }), [
    { state: 'triage', label: 'tr', count: 0, zero: true },
    { state: 'backlog', label: 'bk', count: 0, zero: true },
    { state: 'todo', label: 'td', count: 2, zero: false },
    { state: 'in-progress', label: 'ip', count: 0, zero: true },
    { state: 'done', label: 'dn', count: 0, zero: true },
  ]);
  assert.deepEqual(rollupPills(['custom'], undefined), [{ state: 'custom', label: 'custom', count: 0, zero: true }]);
});

test('parseLogLine: time · sid · rest, with " · " inside the entry kept, and short lines whole', () => {
  assert.deepEqual(parseLogLine('2026-01-01T00:00:00Z · abcd1234 · filed'), { time: '2026-01-01T00:00:00Z', sid: 'abcd1234', rest: 'filed' });
  assert.deepEqual(parseLogLine('t · s · a · b'), { time: 't', sid: 's', rest: 'a · b' });
  assert.deepEqual(parseLogLine('t · only'), { time: '', sid: '', rest: 't · only' });
  assert.deepEqual(parseLogLine('plain'), { time: '', sid: '', rest: 'plain' });
});

test('epicOptions: active then completed slugs; a completed current epic stays selected', () => {
  const epics = [{ slug: 'a', title: '' }, { slug: 'b', title: '', completed: true }, { slug: 'c', title: '' }];
  assert.deepEqual(epicOptions(epics, 'b'), { active: ['a', 'c'], completed: ['b'], value: 'b' });
  assert.equal(epicOptions(epics, 'a').value, 'a');
  assert.equal(epicOptions(epics, null).value, '');
  assert.equal(epicOptions(epics, 'gone').value, '');
});

test('priorityOptions: the unset option leads, and is selected when unset', () => {
  const { options, value } = priorityOptions(META.priorities, null);
  assert.deepEqual(options.map((o) => o.label), ['— unset —', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  assert.deepEqual(options.map((o) => o.value), ['', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  assert.equal(value, '');
  assert.equal(priorityOptions(META.priorities, 'HIGH').value, 'HIGH');
  assert.equal(priorityOptions(META.priorities, 'BOGUS').value, '');
});

test('paths: relative, segments encoded; epicReadPath is cross by slug, scoped under its project', () => {
  assert.equal(cardsPath('a b'), 'api/board/a%20b/cards');
  assert.equal(cardReadPath('p', '2026/1'), 'api/board/p/cards/2026%2F1?includePlan=1');
  assert.equal(movePath('p', 'x'), 'api/board/p/cards/x/move');
  assert.equal(epicsPath('p/q'), 'api/board/p%2Fq/epics');
  assert.equal(epicReadPath({ slug: 's#1', projects: ['a', 'b'] }, 'p'), 'api/epics/s%231?includePlan=1');
  assert.equal(epicReadPath({ slug: 's#1' }, 'p q'), 'api/board/p%20q/epics/s%231?includePlan=1');
});

test('planFromEnvelope: the top-level plan fields', () => {
  assert.deepEqual(planFromEnvelope({ plan_body: 'b', plan_missing: false, plan_truncated: true }), { body: 'b', missing: false, truncated: true });
});

const CARD = { title: '  T  ', goal: 'g', acceptance: ' a \n\n b', epic: '', priority: '', depends_on: ' 1, ,2 ' };

test('splitList: split, trim, drop empties', () => {
  assert.deepEqual(splitList(' a ,, b ', ','), ['a', 'b']);
  assert.deepEqual(splitList('', '\n'), []);
});

test('newCardBody: trimmed title, list fields split, an empty epic and priority omitted', () => {
  const body = newCardBody(CARD);
  assert.deepEqual(body, { title: 'T', goal: 'g', acceptance: ['a', 'b'], depends_on: ['1', '2'] });
  assert.equal('epic' in body, false);
  assert.equal('priority' in body, false);
  assert.deepEqual(newCardBody({ ...CARD, epic: 'e', priority: 'LOW' }).epic, 'e');
  assert.deepEqual(newCardBody({ ...CARD, epic: 'e', priority: 'LOW' }).priority, 'LOW');
});

test("editCardFields: '' clears epic and priority, untouched acceptance omitted, empty title refused", () => {
  const r = editCardFields({ ...CARD, acceptance: 'x\ny' }, 'x\ny');
  assert.deepEqual(r, { fields: { title: 'T', goal: 'g', epic: null, priority: null, depends_on: ['1', '2'] } });
  assert.equal('acceptance' in r.fields, false);
  const changed = editCardFields({ ...CARD, epic: 'e', priority: 'HIGH', acceptance: 'x\nz' }, 'x\ny');
  assert.deepEqual(changed.fields.acceptance, { replace: ['x', 'z'] });
  assert.equal(changed.fields.epic, 'e');
  assert.equal(changed.fields.priority, 'HIGH');
  assert.deepEqual(editCardFields({ ...CARD, title: '   ' }, ''), { error: 'title is required' });
});

test('epicCreateRequest: none → project-scoped, one → refused verbatim, ≥2 → cross-project', () => {
  const v = { slug: ' s ', title: ' T ', goal: 'g', members: [] };
  assert.deepEqual(epicCreateRequest(v, 'p q'), { url: 'api/board/p%20q/epics', body: { slug: 's', title: 'T', goal: 'g' } });
  assert.deepEqual(epicCreateRequest({ ...v, members: ['a'] }, 'p'), { error: ONE_MEMBER_ERROR });
  assert.equal(ONE_MEMBER_ERROR, 'A cross-project epic needs ≥2 projects; select more, or none for a project-scoped epic.');
  assert.deepEqual(epicCreateRequest({ ...v, members: ['a', 'b'] }, 'p'), { url: 'api/epics', body: { slug: 's', title: 'T', goal: 'g', projects: ['a', 'b'] } });
});

test('syncPullBody: trimmed URL; project only for the project scope', () => {
  assert.deepEqual(syncPullBody({ peerUrl: ' https://x/ ', scope: 'project' }, 'p'), { peerUrl: 'https://x/', scope: 'project', project: 'p' });
  const all = syncPullBody({ peerUrl: 'https://x', scope: 'all' }, 'p');
  assert.deepEqual(all, { peerUrl: 'https://x', scope: 'all' });
  assert.equal('project' in all, false);
  assert.deepEqual(syncPullBody({ peerUrl: 'u', scope: '' }, 'p'), { peerUrl: 'u', scope: 'project', project: 'p' });
});

test('syncSummaryText: byte-exact for a minimal and a full summary, singular and plural', () => {
  assert.equal(syncSummaryText({}), 'Sync: 0 added, 0 updated.');
  assert.equal(syncSummaryText(undefined), 'Sync: 0 added, 0 updated.');
  assert.equal(syncSummaryText({
    added: 3, updated: 1, reassigned: [1], epicsAdded: 2, epicConflicts: [1], droppedDeps: [1],
    skippedCards: [1], skippedEpics: [1], skippedProjects: [1],
  }), 'Sync: 3 added, 1 updated, 1 re-id’d, epics +2/~0, 1 epic conflict, 1 dep dropped, 1 malformed skipped, 1 epic skipped, 1 project skipped.');
  assert.equal(syncSummaryText({
    reassigned: [1, 2], epicsUpdated: 4, epicConflicts: [1, 2], droppedDeps: [1, 2],
    skippedCards: [1, 2], skippedEpics: [1, 2], skippedProjects: [1, 2],
  }), 'Sync: 0 added, 0 updated, 2 re-id’d, epics +0/~4, 2 epic conflicts, 2 deps dropped, 2 malformed skipped, 2 epics skipped, 2 projects skipped.');
});

// ---- api() against a stubbed fetch ----

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('api: a root-relative path throws before any request', async () => {
  await withFetch(() => json(200, {}), async (calls) => {
    await assert.rejects(api('/api/board/meta'), /root-relative/);
    assert.equal(calls.length, 0);
  });
});

test('api: a JSON body is stringified with a JSON content type; a GET sends none', async () => {
  await withFetch(() => json(200, { ok: true }), async (calls) => {
    await api('api/x', { method: 'POST', body: { a: 1 } });
    await api('api/y');
    assert.equal(calls[0].url, 'api/x');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, '{"a":1}');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.equal(calls[1].init.method, 'GET');
    assert.equal(calls[1].init.body, undefined);
  });
});

test('api: non-2xx throws ApiError with the body error and code, else "HTTP <status>"', async () => {
  await withFetch(() => json(500, { error: 'boom', code: 'C' }), async () => {
    const e = await api('api/x').catch((err) => err);
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 500);
    assert.equal(e.message, 'boom');
    assert.equal(e.code, 'C');
  });
  await withFetch(() => new Response('UI not built — run npm install', { status: 503 }), async () => {
    const e = await api('api/x').catch((err) => err);
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 503);
    assert.equal(e.message, 'HTTP 503');
    assert.equal(e.code, undefined);
  });
});

test('api: a 2xx refusal envelope is returned, not thrown', async () => {
  await withFetch(() => json(200, { ok: false, code: 'CARD_UNKNOWN', reason: 'no card' }), async () => {
    assert.deepEqual(await api('api/x'), { ok: false, code: 'CARD_UNKNOWN', reason: 'no card' });
  });
});

test('api: a non-JSON 2xx throws "non-JSON <status>"', async () => {
  await withFetch(() => new Response('<html>', { status: 200 }), async () => {
    const e = await api('api/x').catch((err) => err);
    assert.ok(e instanceof ApiError);
    assert.equal(e.message, 'non-JSON 200');
  });
});
