// Worker half of tests/parserTiming.test.mjs: builds one pathological input,
// signals `start`, runs it through the named public entry point, and reports the
// elapsed time. A worker, so the test can terminate a runaway parse at its
// deadline instead of waiting for it.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';

const { kind, n, root } = workerData;
process.env.PROJECTS_ROOT = root;
const cardfile = await import('../src/cardfile.js');
const store = await import('../src/store.js');
const board = await import('../src/board.js');
const { epicsDir } = await import('../src/paths.js');

const pad = ' '.repeat(n);
const card = (body) => `---\nid: 2026-0001\ntitle: t\nproject: demo\ncreated: 2026-01-01T00:00:00.000Z\ndepends_on: []\n---\n${body}`;

const CASES = {
  header: () => cardfile.parse(card(`## Goal\nx\n##${pad}a\rb\n`)),
  acceptance: () => cardfile.parse(card(`## Acceptance\n- [ ]${pad}a b\n`)),
  logbook: () => cardfile.parse(card(`## Logbook\n-${pad}a\rb\n`)),
  epicLogbook: () => {
    fs.mkdirSync(epicsDir('demo'), { recursive: true });
    fs.writeFileSync(path.join(epicsDir('demo'), 'e.md'),
      `---\ntitle: e\nproject: demo\ncreated: 2026-01-01T00:00:00.000Z\n---\n## Goal\ng\n\n## Logbook\n-${pad}a\rb\n`);
    return () => store.readEpic('demo', 'e');
  },
  syncUrl: () => {
    board._setSyncFetcher(async () => { throw new Error('peer not contacted in this test'); });
    return () => board.syncPull({ peerUrl: `http://example.com/${'/'.repeat(n)}a`, scope: 'all' });
  },
  idNumber: () => { const id = `${'1'.repeat(n)}a`; return () => board.trailingIdNumber(id); },
};

// A case returns either its result (it ran during setup — fine only for the pure
// parse, which builds its input inline) or a thunk to time.
const setups = { epicLogbook: true, syncUrl: true, idNumber: true };
const run = setups[kind] ? CASES[kind]() : () => CASES[kind]();
parentPort.postMessage({ type: 'start' });
const t0 = performance.now();
const result = await run();
// A BigInt (trailingIdNumber's result) is posted as is: structured clone carries it, JSON cannot.
const posted = typeof result === 'bigint' ? result : JSON.parse(JSON.stringify(result ?? null));
parentPort.postMessage({ type: 'done', ms: performance.now() - t0, result: posted });
