import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { freshRoot, cleanup } from './_helpers.mjs';

// Linear-time pins for the card, epic, sync and plan-Markdown parsers of untrusted text. Each
// case feeds the pathological shape that made the replaced regex quadratic or
// cubic (a long whitespace or digit run followed by a character the pattern
// refuses) through a public entry point, in a worker that is terminated at the
// deadline. At this size the old regexes take ten seconds or more (the section
// header never finishes); the linear parsers take milliseconds, so the ceiling is
// generous for a contended machine. tests/lineParsers.test.mjs pins correctness.

const N = 200_000;
const DEADLINE_MS = 2_000;

function timeCase(kind, root, deadline = DEADLINE_MS) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./_parserTimingWorker.mjs', import.meta.url), { workerData: { kind, n: N, root } });
    let timer;
    worker.on('message', (msg) => {
      if (msg.type === 'start') {
        timer = setTimeout(() => {
          worker.terminate();
          reject(new Error(`${kind}: no result within ${deadline} ms on a ${N}-character input — a super-linear parser`));
        }, deadline);
      } else {
        clearTimeout(timer);
        worker.terminate();
        resolve(msg);
      }
    });
    worker.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function withRoot(fn) {
  const root = await freshRoot();
  try { return await fn(root); } finally { await cleanup(root); }
}

const opts = { timeout: 15_000 };

test('cardfile.parse: a long section-header whitespace run before a \\r parses in linear time', opts, () => withRoot(async (root) => {
  const { ms, result } = await timeCase('header', root);
  assert.ok(ms < DEADLINE_MS, `${ms} ms`);
  assert.equal(result.goal.startsWith('x'), true);
}));

test('cardfile.parse: a long acceptance whitespace run before a U+2028 parses in linear time', opts, () => withRoot(async (root) => {
  const { ms, result } = await timeCase('acceptance', root);
  assert.ok(ms < DEADLINE_MS, `${ms} ms`);
  assert.deepEqual(result.acceptance, []);
}));

test('cardfile.parse: a long logbook whitespace run before a \\r parses in linear time', opts, () => withRoot(async (root) => {
  const { ms, result } = await timeCase('logbook', root);
  assert.ok(ms < DEADLINE_MS, `${ms} ms`);
  assert.deepEqual(result.logbook, []);
}));

test('store.readEpic: a long epic-logbook whitespace run before a \\r parses in linear time', opts, () => withRoot(async (root) => {
  const { ms, result } = await timeCase('epicLogbook', root);
  assert.ok(ms < DEADLINE_MS, `${ms} ms`);
  assert.equal(result.goal, 'g');
  assert.deepEqual(result.logbook, []);
}));

test('board.syncPull: a peerUrl with a long slash run trims in linear time', opts, () => withRoot(async (root) => {
  const { ms, result } = await timeCase('syncUrl', root);
  assert.ok(ms < DEADLINE_MS, `${ms} ms`);
  assert.equal(result.code, 'SYNC_UNREACHABLE');
}));

test('board.trailingIdNumber: a long digit run before a non-digit reads in linear time', opts, () => withRoot(async (root) => {
  const { ms, result } = await timeCase('idNumber', root);
  assert.ok(ms < DEADLINE_MS, `${ms} ms`);
  assert.equal(result, 0n);
}));

// parsePlan runs on the UI thread, over a model-written body: each shape below is
// one a naive Markdown parser goes super-linear on (deep container nesting, unmatched
// delimiter and bracket runs, rescanned link destinations, backtick runs of every
// length, a header with thousands of columns). The worker parses each at N/2 and at
// 4N, alternating, fastest run of each. Two bounds, each separating linear from
// quadratic by a wide factor:
// - GROWTH, independent of the machine's speed: 8x the input costs about 8x when
//   linear (allocation-heavy shapes reach about 17x) and 64x when quadratic. Read only
//   once the 4N parse is slow enough that timer jitter cannot dominate; below that
//   floor the absolute time already rules quadratic out.
// - the absolute ceiling at 4N: linear parses take tens to hundreds of ms there, a
//   quadratic one tens of seconds.
// `last` is the final character of the parsed text, so a parser that gives up early
// and drops input fails too.
const GROWTH_MAX = 32;
const GROWTH_FLOOR_MS = 50;
const PLAN_DEADLINE_MS = 30_000;
const PLAN_CASES = [
  ['quoteRun', 'x'], ['listRun', 'x'], ['quoteLines', 'x'], ['starOpeners', 'a'], ['starRun', '*'], ['starUnderscore', '_'],
  ['tildes', 'a'], ['backtickRuns', 'a'], ['backtickPairs', 'a'], ['openBrackets', '['], ['linkOpeners', '('],
  ['carriageReturn', 'a'], ['wideTable', 'a'], ['fences', '~'], ['backslashes', '\\'],
  ['frontmatterUnclosed', 'v'],
];
for (const [name, last] of PLAN_CASES) {
  test(`parsePlan: ${name} parses in linear time (bounded growth N/2 → 4N) and keeps its text`, { timeout: 60_000 }, () => withRoot(async (root) => {
    const { result } = await timeCase(`plan:${name}`, root, PLAN_DEADLINE_MS);
    const { small, large } = result;
    assert.ok(large < DEADLINE_MS, `${large} ms at ${4 * N} characters`);
    if (large >= GROWTH_FLOOR_MS) assert.ok(large / small < GROWTH_MAX, `grew ${(large / small).toFixed(1)}x (${small.toFixed(1)} → ${large.toFixed(1)} ms) for 8x the input`);
    assert.ok(result.blocks > 0);
    assert.equal(result.last, last);
  }));
}
