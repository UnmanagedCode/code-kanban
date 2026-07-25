import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { kanbanRoot } from './paths.js';

// Cross-instance sync identity primitives.
//
// - localNodeId(): a stable per-MACHINE id, minted once and persisted at
//   <kanbanRoot>/.node-id. It stamps every card version's `node` field so the
//   LWW merge has a deterministic tiebreak when two versions share `updated`.
// - deriveUid(): a DETERMINISTIC card uid from a tuple both machines share
//   (project, id, created). Used only to backfill cards that predate the sync
//   feature: two machines holding the same shared-lineage legacy card derive the
//   identical uid, so sync unions them instead of duplicating. New cards get a
//   random uid (crypto.randomUUID in board.fileTask), never this.

const NODE_ID_FILE = () => path.join(kanbanRoot(), '.node-id');

// Cache is keyed by the resolved path: tests swap PROJECTS_ROOT between runs, so
// a bare module-level string would leak one root's node id into the next.
let cached = { file: null, id: null };

export function localNodeId() {
  const file = NODE_ID_FILE();
  if (cached.file === file && cached.id) return cached.id;
  let id;
  try {
    id = fs.readFileSync(file, 'utf8').trim();
  } catch {
    id = '';
  }
  if (!id) {
    id = crypto.randomUUID();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${id}\n`);
    fs.renameSync(tmp, file);
  }
  cached = { file, id };
  return id;
}

// UUID-shaped hex derived from the stable tuple. Not a real UUIDv5 (no version
// bits) — just a deterministic, collision-resistant, uuid-looking string.
export function deriveUid(project, id, created) {
  const h = crypto.createHash('sha256')
    .update(`${project}\n${id}\n${created ?? ''}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Test seam: drop the cache so a fresh PROJECTS_ROOT gets its own node id.
export function _resetNodeIdCache() {
  cached = { file: null, id: null };
}
