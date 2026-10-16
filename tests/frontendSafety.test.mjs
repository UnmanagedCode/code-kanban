import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, listUiCode, read, blankComments } from './_sourceScan.mjs';

// DOM-safety guards over the UI's source. A plugin page is same-origin with
// code-conductor and unsandboxed, so model- or user-written content must only ever
// reach the DOM as text: no raw-HTML sinks, no content-built link or style, no
// root-relative API URL (it would reach cc's API), one fetch site, one storage
// site. Comments are blanked first, so prose may name what code may not use. The
// rules run over the real tree, and over a fixture tree that breaks each one, so a
// rule (or a file type) the scan silently stops covering fails here.

const RULES = [
  ['raw-HTML, eval or cross-frame sink', /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write|dangerouslySetInnerHTML|\beval\s*\(|new\s+Function\b|\bDOMParser\b|createContextualFragment|\bsetAttribute\s*\(|location\.hash\s*=|\bpushState\b|window\.parent\b|code-conductor:/],
  ['expression-built link, source or form target', /\b(?:href|src|srcSet|action|formAction|xlinkHref)\s*=\s*\{/],
  ['style attribute or element', /\bstyle\s*=\s*[{"']|<style\b/],
  ['root-relative /api literal', /['"`]\/api\b/],
];
// One permitted site each, repo-relative.
const ONLY_IN = [
  ['fetch call', /\bfetch\s*\(/, 'frontend/src/lib/api.ts'],
  ['localStorage use', /\blocalStorage\b/, 'frontend/src/lib/persist.ts'],
];

/** The files the guards read under `root`: index.html, public/ and src/ (every script type, plus CSS). */
function uiFiles(root) {
  return [
    ...listFiles('frontend/index.html', ['.html'], root),
    ...listUiCode('frontend/public', root),
    ...listUiCode('frontend/src', root),
    ...listFiles('frontend/src', ['.css'], root),
  ];
}

/** `file: rule` for every rule a file under `root` breaks. */
function violations(root) {
  const out = [];
  for (const f of uiFiles(root)) {
    const text = f.endsWith('.html') || f.endsWith('.css') ? read(f, root) : blankComments(read(f, root));
    for (const [rule, re] of RULES) if (re.test(text)) out.push(`${f}: ${rule}`);
    for (const [rule, re, home] of ONLY_IN) if (re.test(text) && f !== home) out.push(`${f}: ${rule}`);
  }
  return out;
}

// Sized well under the real count; a scanner reading nothing would pass everything.
const MIN_FILES = 25;

test('the scan reads the UI source', () => {
  const files = uiFiles(undefined);
  assert.ok(files.length >= MIN_FILES, `scanned only ${files.length} files`);
  assert.ok(files.includes('frontend/src/App.tsx') && files.includes('frontend/public/theme-init.js'));
});

test('the real UI source breaks no DOM-safety rule', () => {
  assert.deepEqual(violations(undefined), []);
});

test('fetch and localStorage each still have their one site', () => {
  for (const [, re, home] of ONLY_IN) assert.match(blankComments(read(home)), re, home);
});

// A fixture tree: one file per script type the bundle can contain, each breaking a rule.
const FIXTURE = {
  'frontend/index.html': '<!doctype html><div style="x"></div>',
  'frontend/public/boot.js': 'document.write("<b>x</b>");',
  'frontend/src/lib/x.js': 'export const put = (el, html) => { el.innerHTML = html; };',
  'frontend/src/lib/y.mjs': "export const u = '/api/board';",
  'frontend/src/View.jsx': 'export const V = ({ u }) => <a href={u}>x</a>;',
  'frontend/src/Card.tsx': 'export const C = () => <p>{fetch("api/x")}</p>;',
  'frontend/src/k.ts': "localStorage.setItem('k', 'v');",
  'frontend/src/clean.ts': '// innerHTML in a comment is prose, not code\nexport const ok = 1;',
};

test('each rule fires on every script type the bundle can contain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kanban-scan-'));
  try {
    for (const [rel, text] of Object.entries(FIXTURE)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    assert.deepEqual(violations(root).sort(), [
      'frontend/index.html: style attribute or element',
      'frontend/public/boot.js: raw-HTML, eval or cross-frame sink',
      'frontend/src/Card.tsx: fetch call',
      'frontend/src/View.jsx: expression-built link, source or form target',
      'frontend/src/k.ts: localStorage use',
      'frontend/src/lib/x.js: raw-HTML, eval or cross-frame sink',
      'frontend/src/lib/y.mjs: root-relative /api literal',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
