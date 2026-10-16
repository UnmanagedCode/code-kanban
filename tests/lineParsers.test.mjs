import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSectionHeader, parseAcceptanceLine, parseLogbookLine } from '../src/cardfile.js';
import { stripTrailingSlashes, trailingIdNumber } from '../src/board.js';

// Differential tests: each linear line parser must return exactly what the regex
// it replaces captured, for every input. The regexes are kept here verbatim as
// the oracle. The inputs are every short string over an alphabet of the
// characters each pattern branches on (the `\s` / `.` split included), behind
// the prefixes that reach each pattern's later branches, plus a seeded sample of
// longer strings. tests/parserTiming.test.mjs pins the other half: linear time.

const ORACLE = {
  header: (line) => { const m = /^##\s+(.+?)\s*$/.exec(line); return m ? m[1] : null; },
  acceptance: (line) => { const m = /^-\s+\[( |x|X)\]\s+(.*)$/.exec(line); return m ? { text: m[2], done: m[1].toLowerCase() === 'x' } : null; },
  logbook: (line) => { const m = /^-\s+(.*)$/.exec(line); return m ? m[1] : null; },
  slashes: (s) => s.replace(/\/+$/, ''),
  idNumber: (id) => { const m = /(\d+)\s*$/.exec(id ?? ''); return m ? Number.parseInt(m[1], 10) : 0; },
};

const SUBJECT = {
  header: parseSectionHeader,
  acceptance: parseAcceptanceLine,
  logbook: parseLogbookLine,
  slashes: stripTrailingSlashes,
  idNumber: trailingIdNumber,
};

// Whitespace `.` accepts (space, tab, U+00A0), whitespace it refuses (the line
// terminators), and the literal characters the patterns name.
const ALPHABET = ['#', '-', '[', ']', 'x', 'X', ' ', '\t', '\u00a0', '\r', '\n', '\u2028', '\u2029', 'a', '1', '/'];

// Prefixes that carry an input past each pattern's leading literals, so the
// exhaustive suffixes exercise the later branches rather than failing at char 0.
const PREFIXES = {
  header: ['', '##', '## ', '##\t', '##\r', '## a'],
  acceptance: ['', '-', '- ', '- [', '- [ ]', '- [x]', '- [X] ', '-\t[ ]\u2028'],
  logbook: ['', '-', '- ', '-\r', '- a'],
  slashes: ['', 'http://h', 'http://h/'],
  idNumber: ['', '2026-', '2026-00', 'a1'],
};

function* strings(maxLen) {
  yield '';
  let layer = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next = [];
    for (const s of layer) for (const ch of ALPHABET) next.push(s + ch);
    yield* next;
    layer = next;
  }
}

// Mulberry32: a fixed seed keeps the sample identical on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* sample(count, seed) {
  const r = rng(seed);
  for (let n = 0; n < count; n++) {
    const len = 6 + Math.floor(r() * 30);
    let s = '';
    // Runs of one character, so whitespace runs long enough to backtrack appear.
    while (s.length < len) s += ALPHABET[Math.floor(r() * ALPHABET.length)].repeat(1 + Math.floor(r() * 4));
    yield s;
  }
}

const EXHAUSTIVE_LEN = 4;
const SAMPLE_COUNT = 4000;

function assertAgrees(kind, inputs) {
  let compared = 0;
  for (const s of inputs) {
    const want = ORACLE[kind](s);
    const got = SUBJECT[kind](s);
    if (want === got || (typeof want === 'object' && want !== null && got !== null
      && typeof got === 'object' && want.text === got.text && want.done === got.done)) {
      compared++;
      continue;
    }
    assert.deepEqual(got, want, `${kind} disagrees with its regex on ${JSON.stringify(s)}`);
  }
  return compared;
}

for (const kind of Object.keys(ORACLE)) {
  test(`${kind}: agrees with its regex on every short string behind each prefix, and a seeded sample`, () => {
    let compared = 0;
    for (const prefix of PREFIXES[kind]) {
      compared += assertAgrees(kind, (function* () { for (const s of strings(EXHAUSTIVE_LEN)) yield prefix + s; })());
      compared += assertAgrees(kind, (function* () { for (const s of sample(SAMPLE_COUNT / PREFIXES[kind].length, kind.length)) yield prefix + s; })());
    }
    // Liveness floor: a generator that yields nothing would make this vacuous.
    assert.ok(compared > 50_000, `compared only ${compared} inputs`);
  });
}

test('header: an all-whitespace remainder still matches, with a one-character name', () => {
  assert.equal(parseSectionHeader('##  '), ' ');
  assert.equal(parseSectionHeader('## \t'), '\t');
  assert.equal(parseSectionHeader('##  \r'), ' ');
  assert.equal(parseSectionHeader('## \r'), null);
  assert.equal(parseSectionHeader('## '), null);
});

test('header: the name is trimmed, and a terminator inside it refuses the line', () => {
  assert.equal(parseSectionHeader('##  Goal  '), 'Goal');
  assert.equal(parseSectionHeader('## Log book\r'), 'Log book');
  assert.equal(parseSectionHeader('## a\rb'), null);
  assert.equal(parseSectionHeader('## a\u2028b'), null);
  assert.equal(parseSectionHeader('## a\u2029b'), null);
  assert.equal(parseSectionHeader('###'), null);
  assert.equal(parseSectionHeader('##Goal'), null);
});

test('acceptance: mark and text, and a terminator in the text refuses the line', () => {
  assert.deepEqual(parseAcceptanceLine('- [x] done it'), { text: 'done it', done: true });
  assert.deepEqual(parseAcceptanceLine('- [X]  Done'), { text: 'Done', done: true });
  assert.deepEqual(parseAcceptanceLine('-\t[ ]\u2028a'), { text: 'a', done: false });
  assert.equal(parseAcceptanceLine('- [ ] a\u2028b'), null);
  assert.equal(parseAcceptanceLine('- [ ] a\u2029b'), null);
  assert.equal(parseAcceptanceLine('- [y] a'), null);
  assert.equal(parseAcceptanceLine('-[ ] a'), null);
  assert.equal(parseAcceptanceLine('- [ ]a'), null);
});

test('logbook: the entry after the dash and whitespace, refused when it holds a terminator', () => {
  assert.equal(parseLogbookLine('- 2026 · abc · filed'), '2026 · abc · filed');
  assert.equal(parseLogbookLine('-  \r x'), 'x');
  assert.equal(parseLogbookLine('- '), '');
  assert.equal(parseLogbookLine('- a\rb'), null);
  assert.equal(parseLogbookLine('- a\nb'), null);
  assert.equal(parseLogbookLine('-a'), null);
});

test('slashes and id numbers: the named shapes', () => {
  assert.equal(stripTrailingSlashes('https://h/board///'), 'https://h/board');
  assert.equal(stripTrailingSlashes('https://h'), 'https://h');
  assert.equal(stripTrailingSlashes('///'), '');
  assert.equal(trailingIdNumber('2026-0042'), 42);
  assert.equal(trailingIdNumber('2026-0042 \t'), 42);
  assert.equal(trailingIdNumber('2026-x'), 0);
  assert.equal(trailingIdNumber(null), 0);
  assert.equal(trailingIdNumber(undefined), 0);
  assert.equal(trailingIdNumber(1234), 1234);
});
