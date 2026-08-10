// Card priority: four verbal levels plus a first-class UNSET state. The SINGLE
// source of the level catalog — src/taskfile.js (disk parse + serialize),
// src/board.js (sort + input validation), conductor.plugin.json's advertised
// enum (guarded by tests/pluginManifest.test.mjs) and the GUI (via
// /api/board/meta) all read it from here. A leaf module with no imports, so
// taskfile.js can use it without a cycle.
//
// Unset is `null`, and it is NOT a level — it is the absence of a judgement.
// There is deliberately no default: a card nobody has judged reads as unjudged,
// because a fabricated MEDIUM is indistinguishable from a deliberate one after
// the fact. Nothing here ever invents a level.
//
// Two DISTINCT entry points, and the distinction is load-bearing:
//   isPriority        — strict. Guards live caller input (file_task/update_task);
//                       a bad value is the author's bug and gets INVALID_STATE.
//   normalizePriority — tolerant. Disk-parse ONLY. A card may predate this build
//                       or arrive by sync from a peer still writing integers; we
//                       have no choice but to load it, so nothing throws and no
//                       card is ever dropped.
// See .wiki/gotchas/priority-legacy-tolerance.md.

// Declaration order IS rank order — highest first. sortTasks ranks by index.
// Unset is not in here: it ranks after the last entry (priorityRank).
export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// The pre-enum integer ladder, as it still sits in on-disk cards and in dumps
// from an old peer. 5 folds onto LOW (the old scale ran 1..5, the new one has
// four levels); 0 — which is what all 166 live cards hold — is deliberately NOT
// here: it meant "never judged", so it falls through to unset like every other
// unrecognised value, which preserves its meaning exactly.
// Null-prototype so a lookup can never resolve to an inherited Object member.
const LEGACY_INT = Object.assign(Object.create(null), {
  1: 'CRITICAL', 2: 'HIGH', 3: 'MEDIUM', 4: 'LOW', 5: 'LOW',
});

// Exactly one of the four canonical literals. Case-sensitive on purpose: the
// tolerant spelling rules belong to normalizePriority, and one entry point
// having two rules costs more than the leniency buys. `null` is FALSE here —
// callers handle it explicitly as the clear-to-unset token rather than widening
// this guard, so a typo can never arrive dressed as a deliberate clear.
export function isPriority(value) {
  return typeof value === 'string' && PRIORITIES.includes(value);
}

// Sort key, ascending = highest priority first. Unset — and any unrecognised
// value — ranks PAST the last level, so an unjudged card never outranks a judged
// one. (The pre-enum ladder sorted unset `0` FIRST; that inversion is the bug
// this whole field has been fighting.) Never -1/NaN: a NaN comparator result is
// silently 0, which would drop the whole card set through to the id tiebreak
// unnoticed.
export function priorityRank(value) {
  const i = PRIORITIES.indexOf(value);
  return i === -1 ? PRIORITIES.length : i;
}

// Tolerant coercion for values read off disk. Never throws. Anything not
// recognised — 0, a larger int, an unknown word, an empty/missing value — is
// unset (null), never a level. Because parse() applies this, a legacy card is
// already holding its true state in memory, so the first write of any kind
// persists it: the tolerant parse IS the migration (there is no migration
// script). serialize() applies it as well, guarding a card object that never
// came through parse().
export function normalizePriority(value) {
  if (typeof value === 'string') {
    const up = value.trim().toUpperCase();
    if (PRIORITIES.includes(up)) return up;
    return LEGACY_INT[up] ?? null;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return LEGACY_INT[value] ?? null;
  }
  return null;
}
