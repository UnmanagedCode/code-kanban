import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceFieldForEdit } from '../frontend/src/lib/acceptanceEdit.ts';

// The card edit form's acceptance-field decision lives in a pure module
// (frontend/src/lib/acceptanceEdit.ts) node:test imports directly.

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
