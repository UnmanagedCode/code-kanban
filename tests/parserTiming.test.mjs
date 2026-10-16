import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { freshRoot, cleanup } from './_helpers.mjs';

// Linear-time pins for the card, epic and sync parsers of untrusted text. Each
// case feeds the pathological shape that made the replaced regex quadratic or
// cubic (a long whitespace or digit run followed by a character the pattern
// refuses) through a public entry point, in a worker that is terminated at the
// deadline. At this size the old regexes take ten seconds or more (the section
// header never finishes); the linear parsers take milliseconds, so the ceiling is
// generous for a contended machine. tests/lineParsers.test.mjs pins correctness.

const N = 200_000;
const DEADLINE_MS = 2_000;

function timeCase(kind, root) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./_parserTimingWorker.mjs', import.meta.url), { workerData: { kind, n: N, root } });
    let timer;
    worker.on('message', (msg) => {
      if (msg.type === 'start') {
        timer = setTimeout(() => {
          worker.terminate();
          reject(new Error(`${kind}: no result within ${DEADLINE_MS} ms on a ${N}-character input — a super-linear parser`));
        }, DEADLINE_MS);
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
  assert.equal(result, 0);
}));
