import test from 'node:test';
import assert from 'node:assert/strict';
import * as priority from '../src/priority.js';
import {
  PRIORITIES, isPriority, priorityRank, normalizePriority,
} from '../src/priority.js';

// Pure module — no temp root, no fs.

test('PRIORITIES is exactly the four levels in rank order (highest first)', () => {
  assert.deepEqual(PRIORITIES, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
});

test('there is no DEFAULT_PRIORITY export — nothing may default an omitted level', () => {
  // The concept, not just the value, is the bug this card corrects: a constant
  // here is an invitation to re-point some call site at it. Its ABSENCE is the
  // invariant, so assert on the module namespace rather than on a value.
  assert.equal('DEFAULT_PRIORITY' in priority, false);
  assert.equal(Object.keys(priority).includes('DEFAULT_PRIORITY'), false);
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

test('priorityRank puts unset AFTER LOW — never first, never tied with MEDIUM', () => {
  // The single most important ordering fact on this card. Three independent
  // assertions, because the three plausible wrong answers are different mutants:
  //   rank(null) = 0 or -1  -> unset floats to the top (the pre-enum bug)
  //   rank(null) = MEDIUM   -> the 2026-0012 regression this card corrects
  //   rank(null) = 3 (LOW)  -> unset ties with a deliberate LOW
  assert.ok(priorityRank('LOW') < priorityRank(null), 'unset must rank below LOW');
  assert.notEqual(priorityRank(null), priorityRank('MEDIUM'));
  assert.notEqual(priorityRank(null), priorityRank('LOW'));
  assert.equal(priorityRank(null), PRIORITIES.length);
  // And the full ladder end to end, unset included, via an actual sort.
  const scrambled = [null, 'LOW', 'CRITICAL', 'MEDIUM', 'HIGH'];
  assert.deepEqual(
    [...scrambled].sort((a, b) => priorityRank(a) - priorityRank(b)),
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', null],
  );
});

test('priorityRank of an unrecognised value ranks last, never NaN', () => {
  // A NaN comparator result is silently 0 — the whole priority key would vanish
  // and every list would fall through to the id tiebreak unnoticed.
  for (const bogus of ['bogus', '', 3, null, undefined]) {
    const r = priorityRank(bogus);
    assert.equal(Number.isNaN(r), false, `rank(${String(bogus)}) is NaN`);
    assert.equal(r, priorityRank(null), `rank(${String(bogus)}) !== rank(unset)`);
    assert.ok(priorityRank('LOW') < r, `rank(${String(bogus)}) must sort below LOW`);
  }
});

test('isPriority is strict — exactly the four canonical literals', () => {
  for (const p of PRIORITIES) assert.equal(isPriority(p), true, p);
  // Everything a tolerant reader would accept must still be REJECTED here: this
  // is the guard on live caller input, and the split from normalizePriority is
  // the whole design. A mutant that delegates to normalizePriority fails this.
  // `null` is false too — callers treat it as the explicit clear-to-unset token,
  // so widening this guard would let a typo arrive dressed as a deliberate clear.
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

test('normalizePriority maps legacy 0 to UNSET, not to a level', () => {
  // Called out on its own because it is the claim the whole card rests on: all
  // 166 pre-existing cards hold `priority: 0`, and 0 meant "never judged".
  // Mapping it to unset preserves that; mapping it to MEDIUM (the 2026-0012
  // behaviour) would invent 166 judgements nobody made. Both wire forms, since
  // the disk value arrives as a string and a peer dump as a number.
  assert.equal(normalizePriority(0), null);
  assert.equal(normalizePriority('0'), null);
  // Explicitly NOT the neighbouring answers, so a mutant returning any level dies.
  for (const level of PRIORITIES) {
    assert.notEqual(normalizePriority(0), level, `0 must not map to ${level}`);
    assert.notEqual(normalizePriority('0'), level, `'0' must not map to ${level}`);
  }
  // 0 is unset while 3 is a real MEDIUM — the two must not collapse together.
  assert.equal(normalizePriority(3), 'MEDIUM');
  assert.notEqual(normalizePriority(0), normalizePriority(3));
});

test('normalizePriority sends everything unrecognised to unset without throwing', () => {
  const bogus = [
    0, '0', 6, 99, -1, 1.5, NaN, Infinity,
    '', '   ', 'URGENT', 'p3', 'none', 'null',
    null, undefined, {}, [], ['HIGH'], true, false,
  ];
  for (const v of bogus) {
    assert.equal(normalizePriority(v), null, `${JSON.stringify(v)} should normalize to unset`);
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
    assert.equal(normalizePriority(key), null, key);
  }
});
