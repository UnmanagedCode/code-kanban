import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listFiles, read, blankComments } from './_sourceScan.mjs';

// DOM-safety guards over the UI's source. A plugin page is same-origin with
// code-conductor and unsandboxed, so model- or user-written content must only ever
// reach the DOM as text: no raw-HTML sinks, no content-built link or style, no
// root-relative API URL (it would reach cc's API), one fetch site, one storage
// site. Comments are blanked first, so prose may name what code may not use.

const FILES = [
  'frontend/index.html',
  ...listFiles('frontend/public', ['.js']),
  ...listFiles('frontend/src', ['.ts', '.tsx', '.css']),
];
const code = (f) => (f.endsWith('.html') || f.endsWith('.css') ? read(f) : blankComments(read(f)));
const SOURCES = FILES.map((f) => [f, code(f)]);

// Sized well under the real count; a scanner reading nothing would pass everything.
const MIN_FILES = 25;

function offenders(re, files = SOURCES) {
  return files.filter(([, text]) => re.test(text)).map(([f]) => f);
}

test('the scan reads the UI source', () => {
  assert.ok(FILES.length >= MIN_FILES, `scanned only ${FILES.length} files`);
  assert.ok(FILES.includes('frontend/src/App.tsx') && FILES.includes('frontend/public/theme-init.js'));
});

test('no raw-HTML, eval or cross-frame sink anywhere in the UI', () => {
  const SINKS = /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write|dangerouslySetInnerHTML|\beval\s*\(|new\s+Function\b|\bDOMParser\b|createContextualFragment|\bsetAttribute\s*\(|location\.hash\s*=|\bpushState\b|window\.parent\b|code-conductor:/;
  assert.deepEqual(offenders(SINKS), []);
});

test('no link, source or form target is built from an expression', () => {
  assert.deepEqual(offenders(/\b(?:href|src|srcSet|action|formAction|xlinkHref)\s*=\s*\{/), []);
});

test('no style attribute or element anywhere, the copied components included', () => {
  assert.deepEqual(offenders(/\bstyle\s*=\s*[{"']|<style\b/), []);
});

test('no root-relative /api URL literal: the page’s origin is cc’s when embedded', () => {
  assert.deepEqual(offenders(/['"`]\/api\b/), []);
});

test('fetch is called only from lib/api.ts, localStorage only from lib/persist.ts', () => {
  assert.deepEqual(offenders(/\bfetch\s*\(/), ['frontend/src/lib/api.ts']);
  assert.deepEqual(offenders(/\blocalStorage\b/), ['frontend/src/lib/persist.ts']);
});
