import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceFieldForEdit } from '../frontend/acceptanceEdit.js';

// The web GUI has no frontend test framework of its own, so doEdit's
// acceptance-field decision lives in a pure module (frontend/acceptanceEdit.js)
// node:test can import directly — same pattern as persist.js.

test('an unchanged textarea (current === prefill) omits the field entirely', () => {
  assert.equal(acceptanceFieldForEdit('a\nb', 'a\nb'), undefined);
  assert.equal(acceptanceFieldForEdit('', ''), undefined);
});

test('a changed textarea sends {replace:[...]}, split/trimmed/filtered', () => {
  assert.deepEqual(acceptanceFieldForEdit('a\nb\nc', 'a\nb'), { replace: ['a', 'b', 'c'] });
  assert.deepEqual(acceptanceFieldForEdit('  a  \n\nb', 'a\nb'), { replace: ['a', 'b'] }); // blank lines dropped, text trimmed
});

test('clearing the textarea to empty sends {replace: []}, not an omission', () => {
  assert.deepEqual(acceptanceFieldForEdit('', 'a\nb'), { replace: [] });
});
