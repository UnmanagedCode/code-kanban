import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, proseFiles } from './_prose.mjs';

// A markdown heading directly under a text line is not reliably a heading: some
// renderers fold it into the paragraph above. Every heading in the prose layers
// (outside fenced code) has a blank line, or the file's start, above it.

/** The markdown headings in `text` (outside fenced code): `{line, crowded}`, 1-based. */
function headings(text) {
  const lines = text.split('\n');
  const out = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced || !/^#{1,6} /.test(line)) return;
    out.push({ line: i + 1, crowded: i > 0 && lines[i - 1].trim() !== '' });
  });
  return out;
}

/** 1-based line numbers of the headings in `text` with a text line directly above. */
const crowdedHeadings = (text) => headings(text).filter((h) => h.crowded).map((h) => h.line);

// Liveness floor, far under the real count: a walk that finds no headings proves nothing.
const MIN_HEADINGS = 100;

test('every heading in the prose layers follows a blank line', () => {
  const crowded = [];
  let count = 0;
  for (const rel of proseFiles()) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    count += headings(text).length;
    for (const line of crowdedHeadings(text)) crowded.push(`${rel}:${line}`);
  }
  assert.ok(count >= MIN_HEADINGS, `checked only ${count} headings`);
  assert.deepEqual(crowded, []);
});

// The rule itself must still fire: a gate whose check is removed or inverted would
// pass the clean corpus above unchanged.
test('the heading rule flags a crowded heading, and only that', () => {
  assert.deepEqual(crowdedHeadings('text\n# heading\n'), [2]);
  assert.deepEqual(crowdedHeadings('para\n\n## spaced\ntext\n### crowded\n'), [5]);
  assert.deepEqual(crowdedHeadings('# first line\n\ntext\n'), [], 'a heading at the start of a file');
  assert.deepEqual(crowdedHeadings('text\n\n# heading\n'), [], 'a heading after a blank line');
  assert.deepEqual(crowdedHeadings('```\ntext\n# a comment, not a heading\n```\n'), [], 'a # inside a code fence');
});
