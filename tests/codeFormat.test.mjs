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

// Liveness floor, far under the real count: a walk that reads nothing proves nothing.
const MIN_FILES = 60;

test('no code file holds two blank lines in a row', () => {
  assert.ok(CODE.length >= MIN_FILES, `read only ${CODE.length} files`);
  const doubled = [];
  for (const f of CODE) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      if (i > 0 && line.trim() === '' && lines[i - 1].trim() === '' && i < lines.length - 1) doubled.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(doubled, []);
});
