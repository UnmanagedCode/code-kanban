import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshRoot, cleanup } from './_helpers.mjs';
import { localNodeId, deriveUid, _resetNodeIdCache } from '../src/nodeId.js';
import { kanbanRoot } from '../src/paths.js';

test('localNodeId mints once and is stable across calls', async () => {
  const root = await freshRoot();
  _resetNodeIdCache();
  try {
    const a = localNodeId();
    const b = localNodeId();
    assert.equal(a, b);
    assert.ok(a.length > 0);
    // Persisted to disk so a later process reuses it.
    const onDisk = fs.readFileSync(path.join(kanbanRoot(), '.node-id'), 'utf8').trim();
    assert.equal(onDisk, a);
  } finally {
    await cleanup(root);
  }
});

test('localNodeId differs per machine (per PROJECTS_ROOT)', async () => {
  const r1 = await freshRoot();
  _resetNodeIdCache();
  const id1 = localNodeId();
  const r2 = await freshRoot();
  _resetNodeIdCache();
  const id2 = localNodeId();
  try {
    assert.notEqual(id1, id2);
  } finally {
    await cleanup(r1);
    await cleanup(r2);
  }
});

test('deriveUid is deterministic for an identical tuple', () => {
  const a = deriveUid('alpha', '2026-0001', '2026-01-01T00:00:00.000Z');
  const b = deriveUid('alpha', '2026-0001', '2026-01-01T00:00:00.000Z');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('deriveUid differs when any tuple component differs', () => {
  const base = deriveUid('alpha', '2026-0001', '2026-01-01T00:00:00.000Z');
  assert.notEqual(base, deriveUid('beta', '2026-0001', '2026-01-01T00:00:00.000Z'));
  assert.notEqual(base, deriveUid('alpha', '2026-0002', '2026-01-01T00:00:00.000Z'));
  // Same project+id but a different creation instant -> a distinct card.
  assert.notEqual(base, deriveUid('alpha', '2026-0001', '2026-01-01T00:00:00.001Z'));
});
