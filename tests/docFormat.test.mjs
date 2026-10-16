import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, proseFiles } from './_prose.mjs';

// A markdown heading directly under a text line is not reliably a heading: some
// renderers fold it into the paragraph above. Every heading in the prose layers
// (outside fenced code) has a blank line, or the file's start, above it.

// Liveness floor, far under the real count: a walk that finds no headings proves nothing.
const MIN_HEADINGS = 100;

test('every heading in the prose layers follows a blank line', () => {
  const crowded = [];
  let headings = 0;
  for (const rel of proseFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    let fenced = false;
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced || !/^#{1,6} /.test(line)) return;
      headings++;
      if (i > 0 && lines[i - 1].trim() !== '') crowded.push(`${rel}:${i + 1}: ${line}`);
    });
  }
  assert.ok(headings >= MIN_HEADINGS, `checked only ${headings} headings`);
  assert.deepEqual(crowded, []);
});
