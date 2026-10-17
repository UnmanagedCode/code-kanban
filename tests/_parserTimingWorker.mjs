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
const { parsePlan } = await import('../frontend/src/lib/planMarkdown.ts');

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

// Hostile plan bodies for parsePlan, each built at a given size `m` before the clock starts.
const backtickRuns = (m) => { let s = ''; for (let i = 1; s.length < m; i++) s += `${'`'.repeat(i)}a`; return s; };
const PLAN_INPUTS = {
  quoteRun: (m) => `${'> '.repeat(m / 2)}x`,
  listRun: (m) => `${'- '.repeat(m / 2)}x`,
  // Lines of increasing `>` depth, about m characters in all.
  quoteLines: (m) => Array.from({ length: Math.round(Math.sqrt(2 * m)) }, (_, k) => `${'>'.repeat(k + 1)} x`).join('\n'),
  starOpeners: (m) => '*a '.repeat(m / 3),
  // Led by a letter, or the run would be a thematic break.
  starRun: (m) => `x${'**'.repeat(m / 2)}`,
  starUnderscore: (m) => '*_'.repeat(m / 2),
  tildes: (m) => '~~a'.repeat(m / 3),
  backtickRuns,
  backtickPairs: (m) => 'a`'.repeat(m / 2),
  openBrackets: (m) => '['.repeat(m),
  linkOpeners: (m) => '[a]('.repeat(m / 4),
  carriageReturn: (m) => `${'a'.repeat(m)}\r`,
  wideTable: (m) => `${'|a'.repeat(m / 4)}\n${'|-'.repeat(m / 4)}`,
  fences: (m) => '```\n~~~\n'.repeat(m / 8),
  backslashes: (m) => '\\'.repeat(m),
};
/** Every text and code string in the tree, concatenated: a cheap check the parse kept the input. */
const textOf = (nodes) => nodes.map((x) => (typeof x.text === 'string' ? x.text : '')
  + textOf(x.children ?? []) + textOf((x.items ?? []).map((it) => ({ children: it.children })))
  + textOf([...(x.head ?? []), ...(x.rows ?? []).flat()].map((cell) => ({ children: cell })))).join('');
/** Wall time of one parse of `src`, in ms, and its blocks. */
const timed = (src) => {
  const t0 = performance.now();
  const blocks = parsePlan(src);
  return { ms: performance.now() - t0, blocks };
};
// Timed at n/2 and at 4n (8x the input): about 8x the time when linear, 64x when quadratic,
// whatever the machine's speed. The two sizes alternate, so a burst of load on a shared
// machine slows both, and each keeps its fastest run (load only ever adds time).
const ROUNDS = 4;
for (const [name, build] of Object.entries(PLAN_INPUTS)) {
  CASES[`plan:${name}`] = () => {
    const small = build(n / 2);
    const large = build(4 * n);
    parsePlan(build(n / 4));
    return () => {
      let s = Infinity;
      let l = Infinity;
      let blocks;
      for (let r = 0; r < ROUNDS; r++) {
        s = Math.min(s, timed(small).ms);
        const run = timed(large);
        l = Math.min(l, run.ms);
        blocks = run.blocks;
      }
      return { small: s, large: l, blocks: blocks.length, last: textOf(blocks).slice(-1) };
    };
  };
}

// A case returns either its result (it ran during setup — fine only for the pure
// parse, which builds its input inline) or a thunk to time.
const setups = { epicLogbook: true, syncUrl: true, idNumber: true };
const run = setups[kind] || kind.startsWith('plan:') ? CASES[kind]() : () => CASES[kind]();
parentPort.postMessage({ type: 'start' });
const t0 = performance.now();
const result = await run();
// A BigInt (trailingIdNumber's result) is posted as is: structured clone carries it, JSON cannot.
const posted = typeof result === 'bigint' ? result : JSON.parse(JSON.stringify(result ?? null));
parentPort.postMessage({ type: 'done', ms: performance.now() - t0, result: posted });
