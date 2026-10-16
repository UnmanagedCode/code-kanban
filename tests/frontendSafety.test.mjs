import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, listUiCode, read, blankComments, openingTags, hasSpread } from './_sourceScan.mjs';

// DOM-safety guards over the UI's source. A plugin page is same-origin with
// code-conductor and unsandboxed, so model- or user-written content must only ever
// reach the DOM as text: no raw-HTML sinks, no content-built link or style, no
// root-relative API URL (it would reach cc's API), one fetch site, one storage
// site, no JSX spread props in the plugin's own components (a spread object can
// carry any of those props past the attribute rules). Comments are blanked first, so prose may name what code may not use. The
// rules run over the real tree, and over a fixture tree that breaks each one, so a
// rule (or a file type) the scan silently stops covering fails here.

const RULES = [
  ['raw-HTML, eval or cross-frame sink', /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write|dangerouslySetInnerHTML|\beval\s*\(|new\s+Function\b|\bDOMParser\b|createContextualFragment|\bsetAttribute\s*\(|location\.hash\s*=|\bpushState\b|window\.parent\b|code-conductor:/],
  ['expression-built link, source or form target', /\b(?:href|src|srcSet|action|formAction|xlinkHref)\s*=\s*\{/],
  // Every way a style reaches the DOM: the JSX/HTML attribute, a <style> element, a
  // `style:` props key (an object spread or React.createElement), and any `.style` /
  // `['style']` access on an element (`.style = …`, `.style.x = …`, `.style.setProperty`).
  ['style attribute or element', /\bstyle\s*=\s*[{"'`]|<style\b|createElement\(\s*['"`]style['"`]|(?<![\w$-])style\s*\??\s*:|\.style\b|\[\s*['"`]style['"`]\s*\]/],
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

const isFeatureCode = (f) => f.startsWith('frontend/src/') && !f.startsWith('frontend/src/components/ui/') && !f.endsWith('.css');

/** `file: rule` for every rule a file under `root` breaks, and how many JSX tags the spread rule read. */
function scan(root) {
  const out = [];
  let tags = 0;
  for (const f of uiFiles(root)) {
    const text = f.endsWith('.html') || f.endsWith('.css') ? read(f, root) : blankComments(read(f, root));
    for (const [rule, re] of RULES) if (re.test(text)) out.push(`${f}: ${rule}`);
    for (const [rule, re, home] of ONLY_IN) if (re.test(text) && f !== home) out.push(`${f}: ${rule}`);
    if (!isFeatureCode(f)) continue;
    for (const tag of openingTags(text)) {
      tags++;
      if (hasSpread(tag.attrs)) out.push(`${f}: JSX spread props`);
    }
  }
  return { out, tags };
}
const violations = (root) => scan(root).out;

// Sized well under the real count; a scanner reading nothing would pass everything.
const MIN_FILES = 25;
const MIN_FEATURE_JSX_TAGS = 100;

test('the scan reads the UI source', () => {
  const files = uiFiles(undefined);
  assert.ok(files.length >= MIN_FILES, `scanned only ${files.length} files`);
  assert.ok(files.includes('frontend/src/App.tsx') && files.includes('frontend/public/theme-init.js'));
});

test('the real UI source breaks no DOM-safety rule', () => {
  const { out, tags } = scan(undefined);
  assert.deepEqual(out, []);
  assert.ok(tags >= MIN_FEATURE_JSX_TAGS, `the spread rule read only ${tags} JSX tags in feature code`);
});

test('fetch and localStorage each still have their one site', () => {
  for (const [, re, home] of ONLY_IN) assert.match(blankComments(read(home)), re, home);
});

// A fixture tree: one file per script type the bundle can contain, each breaking a
// rule; plus the shapes that must NOT trip one (a comment, a spread inside the copied
// components/ui/, `font-style` in CSS).
const FIXTURE = {
  'frontend/index.html': '<!doctype html><div style="x"></div>',
  'frontend/public/boot.js': 'document.write("<b>x</b>");',
  'frontend/src/lib/x.js': 'export const put = (el, html) => { el.innerHTML = html; };',
  'frontend/src/lib/y.mjs': "export const u = '/api/board';",
  'frontend/src/View.jsx': 'export const V = ({ u }) => <a href={u}>x</a>;',
  'frontend/src/Card.tsx': 'export const C = () => <p>{fetch("api/x")}</p>;',
  'frontend/src/k.ts': "localStorage.setItem('k', 'v');",
  'frontend/src/clean.ts': '// innerHTML in a comment is prose, not code\nexport const ok = 1;',
  'frontend/src/Styled.jsx': "export const S = (v) => React.createElement('div', { style: v.css });",
  'frontend/src/lib/paint.js': 'export const paint = (el, v) => { el.style = v; };',
  'frontend/src/lib/tint.ts': 'export const tint = (el: HTMLElement, v: string) => { el.style.color = v; };',
  'frontend/src/Spread.tsx': 'export const P = (p: object) => <div className="x" {...p} />;',
  'frontend/src/components/ui/slot.tsx': 'export const Slot = (p: object) => <span {...p} />;',
  'frontend/src/styles.css': '.x { font-style: italic; }',
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
      'frontend/src/Spread.tsx: JSX spread props',
      'frontend/src/Styled.jsx: style attribute or element',
      'frontend/src/View.jsx: expression-built link, source or form target',
      'frontend/src/k.ts: localStorage use',
      'frontend/src/lib/paint.js: style attribute or element',
      'frontend/src/lib/tint.ts: style attribute or element',
      'frontend/src/lib/x.js: raw-HTML, eval or cross-frame sink',
      'frontend/src/lib/y.mjs: root-relative /api literal',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
