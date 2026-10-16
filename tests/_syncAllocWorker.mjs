// Worker half of tests/sync.test.mjs's id-allocator deadline test: seeds a local
// card numbered just above 2^53, pulls a canned peer dump whose two cards force a
// reassignment at that magnitude, and posts the pull's summary. A worker, so the
// test can terminate an allocator that never returns instead of hanging the file.
import { parentPort, workerData } from 'node:worker_threads';

const { root } = workerData;
process.env.PROJECTS_ROOT = root;
const store = await import('../src/store.js');
const board = await import('../src/board.js');
const { _setProjectFetcher } = await import('../src/projects.js');

_setProjectFetcher(async () => ['alpha']);
const year = new Date().getFullYear();
// 2^53 + 1: as a float it rounds to 2^53, so float `+ 1` from either never moves.
const local = `${year}-9007199254740993`;
const rounded = `${year}-9007199254740992`;
const card = (id, uid, title) => ({
  id, uid, title, project: 'alpha', epic: null, priority: null,
  created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', node: 'n',
  owner: null, plan: null, depends_on: [], goal: '', acceptance: [], logbook: [], state: 'triage',
});
store.ensureProjectDirs('alpha');
store.writeCard('alpha', 'triage', card(local, 'u-local', 'Local'));
board._setSyncFetcher(async () => ({
  ok: true, nodeId: 'peer', projects: { alpha: [
    card(rounded, 'u-rounded', 'Rounded'), // free locally: keeps its id, and is the float's next candidate
    card(local, 'u-collide', 'Collide'),   // collides with the local card: must be reassigned
  ] },
}));
parentPort.postMessage({ type: 'start', year });
const r = await board.syncPull({ peerUrl: 'http://peer.test', scope: 'project', project: 'alpha' });
parentPort.postMessage({ type: 'done', result: r });
