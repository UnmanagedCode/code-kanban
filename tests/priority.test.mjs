import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIORITIES, DEFAULT_PRIORITY, isPriority, priorityRank, normalizePriority,
} from '../src/priority.js';

// Pure module — no temp root, no fs.

test('PRIORITIES is exactly the four levels in rank order (highest first)', () => {
  assert.deepEqual(PRIORITIES, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  assert.equal(DEFAULT_PRIORITY, 'MEDIUM');
});

test('priorityRank orders CRITICAL first through LOW last', () => {
  // Sorting a deliberately-scrambled input by rank must reproduce PRIORITIES
  // exactly. Pins DIRECTION: a reversed or shuffled rank map fails here.
  const scrambled = ['LOW', 'MEDIUM', 'CRITICAL', 'HIGH'];
  assert.deepEqual(
    [...scrambled].sort((a, b) => priorityRank(a) - priorityRank(b)),
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
  );
  // And each individual step of the ladder, so collapsing two adjacent levels
  // onto one rank is caught too.
  assert.ok(priorityRank('CRITICAL') < priorityRank('HIGH'));
  assert.ok(priorityRank('HIGH') < priorityRank('MEDIUM'));
  assert.ok(priorityRank('MEDIUM') < priorityRank('LOW'));
});

test('priorityRank of an unrecognised value is the MEDIUM rank, never NaN', () => {
  // A NaN comparator result is silently 0 — the whole priority key would vanish
  // and every list would fall through to the id tiebreak unnoticed.
  for (const bogus of ['bogus', '', 3, null, undefined]) {
    const r = priorityRank(bogus);
    assert.equal(Number.isNaN(r), false, `rank(${String(bogus)}) is NaN`);
    assert.equal(r, priorityRank('MEDIUM'), `rank(${String(bogus)}) !== rank(MEDIUM)`);
  }
  assert.equal(priorityRank('LOW') > priorityRank('bogus'), true);
});

test('isPriority is strict — exactly the four canonical literals', () => {
  for (const p of PRIORITIES) assert.equal(isPriority(p), true, p);
  // Everything a tolerant reader would accept must still be REJECTED here: this
  // is the guard on live caller input, and the split from normalizePriority is
  // the whole design. A mutant that delegates to normalizePriority fails this.
  for (const bad of ['medium', 'Medium', ' HIGH', 'HIGH ', 'URGENT', '', '2', 2, 0, null, undefined, {}, ['HIGH']]) {
    assert.equal(isPriority(bad), false, `isPriority(${JSON.stringify(bad)}) should be false`);
  }
});

test('normalizePriority maps each legacy integer to its specific level', () => {
  // Exact per-value assertions: an off-by-one shift in the map, or a collapse to
  // a single level, changes at least one of these.
  const cases = [
    [1, 'CRITICAL'], [2, 'HIGH'], [3, 'MEDIUM'], [4, 'LOW'], [5, 'LOW'],
    ['1', 'CRITICAL'], ['2', 'HIGH'], ['3', 'MEDIUM'], ['4', 'LOW'], ['5', 'LOW'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizePriority(input), expected, `${JSON.stringify(input)} -> ${expected}`);
  }
});

test('normalizePriority sends everything unrecognised to MEDIUM without throwing', () => {
  // 0 is the important one: all 166 pre-existing cards hold it, and it is
  // deliberately NOT in the legacy map (it meant "unset", which no longer exists).
  const bogus = [
    0, '0', 6, 99, -1, 1.5, NaN, Infinity,
    '', '   ', 'URGENT', 'p3', 'none', 'null',
    null, undefined, {}, [], ['HIGH'], true, false,
  ];
  for (const v of bogus) {
    assert.equal(normalizePriority(v), 'MEDIUM', `${JSON.stringify(v)} should normalize to MEDIUM`);
  }
});

test('normalizePriority accepts the canonical levels, case- and space-insensitively', () => {
  for (const p of PRIORITIES) {
    assert.equal(normalizePriority(p), p);
    assert.equal(normalizePriority(p.toLowerCase()), p);
    assert.equal(normalizePriority(`  ${p}  `), p);
  }
});

test('normalizePriority never resolves to an inherited Object member', () => {
  // LEGACY_INT is a plain lookup; a prototype hit would return a function and
  // escape the enum entirely.
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(normalizePriority(key), 'MEDIUM', key);
  }
});
