// Card priority: four verbal levels, no unset state. The SINGLE source of the
// level catalog — src/taskfile.js (disk parse + serialize), src/board.js (sort +
// input validation), conductor.plugin.json's advertised enum (guarded by
// tests/pluginManifest.test.mjs) and the GUI (via /api/board/meta) all read it
// from here. A leaf module with no imports, so taskfile.js can use it without a
// cycle.
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
export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export const DEFAULT_PRIORITY = 'MEDIUM';

// The pre-enum integer ladder, as it still sits in on-disk cards and in dumps
// from an old peer. 5 folds onto LOW (the old scale ran 1..5, the new one has
// four levels); 0 — which is what all 166 live cards hold — is deliberately NOT
// here: it meant "unset", and unset is now MEDIUM.
// Null-prototype so a lookup can never resolve to an inherited Object member.
const LEGACY_INT = Object.assign(Object.create(null), {
  1: 'CRITICAL', 2: 'HIGH', 3: 'MEDIUM', 4: 'LOW', 5: 'LOW',
});

// Exactly one of the four canonical literals. Case-sensitive on purpose: the
// tolerant spelling rules belong to normalizePriority, and one entry point
// having two rules costs more than the leniency buys.
export function isPriority(value) {
  return typeof value === 'string' && PRIORITIES.includes(value);
}

// Sort key, ascending = highest priority first. An unrecognised value ranks as
// MEDIUM rather than -1/NaN: a NaN comparator result is silently 0, which would
// drop the whole card set through to the id tiebreak unnoticed.
export function priorityRank(value) {
  const i = PRIORITIES.indexOf(value);
  return i === -1 ? PRIORITIES.indexOf(DEFAULT_PRIORITY) : i;
}

// Tolerant coercion for values read off disk. Never throws. Anything not
// recognised — 0, a larger int, an unknown word, an empty/missing value — is
// MEDIUM. Because serialize() runs this too, a legacy card is rewritten in the
// new vocabulary the first time anything writes it: the tolerant parse IS the
// migration (there is no migration script).
export function normalizePriority(value) {
  if (typeof value === 'string') {
    const up = value.trim().toUpperCase();
    if (PRIORITIES.includes(up)) return up;
    return LEGACY_INT[up] ?? DEFAULT_PRIORITY;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return LEGACY_INT[value] ?? DEFAULT_PRIORITY;
  }
  return DEFAULT_PRIORITY;
}
