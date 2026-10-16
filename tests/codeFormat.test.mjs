import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listFiles, listUiCode, read } from './_sourceScan.mjs';

// No run of two or more blank lines in the repo's own code: one blank line
// separates blocks, so a doubled one is debris from an edit.

const CODE = [
  'server.js',
  ...listFiles('src', ['.js']),
  ...listFiles('tests', ['.mjs']),
  ...listFiles('harness', ['.mjs']),
  ...listFiles('frontend', ['.ts']).filter((f) => !f.includes('/dist/') && !f.includes('/src/')),
  ...listUiCode('frontend/src'),
  ...listUiCode('frontend/public'),
];

/**
 * 1-based line numbers in `text` of each blank line that follows another blank line
 * (whitespace-only counts as blank). The empty string after a final newline is not a line.
 */
function doubledLines(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (i > 0 && i < lines.length - 1 && line.trim() === '' && lines[i - 1].trim() === '') out.push(i + 1);
  });
  return out;
}

// Liveness floor, far under the real count: a walk that reads nothing proves nothing.
const MIN_FILES = 60;

test('no code file holds two blank lines in a row', () => {
  assert.ok(CODE.length >= MIN_FILES, `read only ${CODE.length} files`);
  const doubled = [];
  for (const f of CODE) for (const line of doubledLines(read(f))) doubled.push(`${f}:${line}`);
  assert.deepEqual(doubled, []);
});

// The rule itself must still fire: a gate whose check is removed or inverted would
// pass the clean tree above unchanged.
test('the blank-line rule flags a doubled blank line, and only that', () => {
  assert.deepEqual(doubledLines('a\n\n\nb'), [3]);
  assert.deepEqual(doubledLines('a\n  \n\t\nb\n'), [3], 'whitespace-only lines are blank');
  assert.deepEqual(doubledLines('a\n\n\n\nb\n'), [3, 4]);
  assert.deepEqual(doubledLines('a\n\nb\n'), [], 'a single blank line');
  assert.deepEqual(doubledLines('a\nb\n'), [], 'a final newline');
});
