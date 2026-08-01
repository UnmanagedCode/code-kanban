import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SELECTED_PROJECT_KEY, readSelectedProject, writeSelectedProject, resolveInitialProject } from '../frontend/persist.js';

// The web GUI has no frontend test framework of its own, so the persistence
// helpers live in a pure module (frontend/persist.js) node:test can import.
// This suite pins the storage key namespace, the read/write behavior, and the
// stale-saved-project fallback.

function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

test('readSelectedProject returns null when the key is absent', () => {
  assert.equal(readSelectedProject(fakeStorage()), null);
});

test('reads only the namespaced key, ignoring other apps on the same origin', () => {
  const s = fakeStorage({ 'other-app:selected-project': 'demo' });
  assert.equal(readSelectedProject(s), null);
});

test('write/read round-trips under the exact namespaced key', () => {
  const s = fakeStorage();
  writeSelectedProject('demo', s);
  assert.equal(s.getItem(SELECTED_PROJECT_KEY), 'demo');
  assert.equal(readSelectedProject(s), 'demo');
});

test('writing a falsy name removes the key', () => {
  const s = fakeStorage({ [SELECTED_PROJECT_KEY]: 'demo' });
  writeSelectedProject(null, s);
  assert.equal(s.getItem(SELECTED_PROJECT_KEY), null);
  assert.equal(readSelectedProject(s), null);
});

test('a throwing getItem degrades to null instead of throwing', () => {
  const throwing = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
    removeItem() { throw new Error('storage denied'); },
  };
  assert.equal(readSelectedProject(throwing), null);
});

test('a throwing setItem is logged, not thrown', () => {
  const throwing = {
    getItem: () => null,
    setItem() { throw new Error('quota exceeded'); },
    removeItem() { throw new Error('quota exceeded'); },
  };
  assert.doesNotThrow(() => writeSelectedProject('demo', throwing));
});

test('resolveInitialProject keeps the saved project while it still exists', () => {
  assert.equal(resolveInitialProject(['demo', 'web'], 'web'), 'web');
});

test('resolveInitialProject falls back to the first project when the saved one is stale or absent', () => {
  assert.equal(resolveInitialProject(['demo', 'web'], 'gone'), 'demo');
  assert.equal(resolveInitialProject(['demo', 'web'], null), 'demo');
});

test('resolveInitialProject returns null when there are no projects', () => {
  assert.equal(resolveInitialProject([], 'demo'), null);
});
