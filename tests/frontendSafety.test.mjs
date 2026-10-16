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

// Each rule carries `bad`: known-bad samples, at least one per alternative of its
// pattern. The liveness test runs them through the same check the scan uses, so a
// pattern that stops matching (or loses an alternative) fails even though the real
// tree, which is meant to be clean, still reads as clean.
const RULES = [
  {
    // Raw markup, script evaluation, attribute writes that bypass React, navigation
    // (not governed by the CSP), cookies, and messages to or scripting of cc's frame.
    name: 'raw-HTML, eval or cross-frame sink',
    re: /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write|dangerouslySetInnerHTML|\beval\s*\(|new\s+Function\b|\bDOMParser\b|createContextualFragment|\bsetAttribute\s*\(|location\.hash\s*=|\bpushState\b|window\.parent\b|code-conductor:|location\s*\.\s*(?:href|assign|replace)\s*=|location\s*\.\s*(?:assign|replace)\s*\(|document\s*\.\s*cookie|\bparent\s*\.\s*postMessage|\bsetAttributeNS\s*\(|\binsertAdjacentElement\s*\(/,
    bad: [
      'el.innerHTML = html', 'el.outerHTML = html', "el.insertAdjacentHTML('beforeend', h)", 'document.write(h)',
      '<div dangerouslySetInnerHTML={{ __html: h }} />', 'eval(code)', "new Function('return 1')", 'new DOMParser()',
      'range.createContextualFragment(h)', "el.setAttribute('href', u)", "location.hash = '#x'", "history.pushState(null, '', u)",
      'window.parent.postMessage(m)', "localStorage.getItem('code-conductor:theme')",
      // Navigation is not governed by the CSP: a content-built URL there is a javascript: link.
      'location.href = u', 'window.location . assign = f', 'location.replace = f', 'location.assign(u)', 'window.location.replace (u)',
      'const c = document.cookie', 'parent.postMessage(m, origin)', "el.setAttributeNS(null, 'href', u)",
      "el.insertAdjacentElement('afterend', node)",
    ],
  },
  {
    name: 'expression-built link, source or form target',
    re: /\b(?:href|src|srcSet|action|formAction|xlinkHref)\s*=\s*\{/,
    bad: ['<a href={u}>', '<img src={u} />', '<img srcSet={u} />', '<form action={u}>', '<button formAction={u}>', '<use xlinkHref={u} />'],
  },
  {
    // UI source never styles an element from code, by any route, in any letter case: the JSX/HTML
    // attribute, a <style> element, a `style` key anywhere (a React.createElement
    // props object, an object spread — and, deliberately, a type such as
    // `{ style?: string }`: no UI type names a style key either, quoted or bare, which keeps the key
    // rule free of the type-vs-value guesswork a stricter anchor would need), and any
    // `.style` / `['style']` access on an element (`.style = …`, `.style.x = …`,
    // `.style.setProperty`).
    name: 'a style by any route (attribute, <style>, a style key, .style access)',
    // Case-insensitive: `createElement('STYLE')` still yields an HTMLStyleElement,
    // and HTML tag names fold case. The lookbehind keeps CSS's `font-style:` exempt.
    re: /\bstyle\s*=\s*[{"'`]|<style\b|createElement\(\s*['"`]style['"`]|(?<![\w$-])style\s*\??\s*:|['"`]style['"`]\s*:|\.style\b|\[\s*['"`]style['"`]\s*\]/i,
    bad: [
      '<p style={{ color: c }} />', '<p style="color:red">', "<p style='color:red'>", '<p style=`x`>', '<style>p{}</style>',
      "document.createElement('style')", "React.createElement('div', { style: v.css })", 'const p = { style: v }',
      'el.style = v', 'el.style.color = v', "el.style.setProperty('color', v)", "el['style'] = v",
      'type P = { style?: string }', 'interface Q { style: CSSProperties }',
      "React.createElement('div', { 'style': v.css })", 'React.createElement("div", { "style": v.css })',
      "document.createElement('STYLE')", "document.createElement('Style')", '<STYLE>p{}</STYLE>', '<p STYLE="color:red">',
    ],
  },
  {
    name: 'root-relative /api literal',
    re: /['"`]\/api\b/,
    bad: ["fetch('/api/x')", 'fetch("/api/x")', 'fetch(`/api/${p}`)'],
  },
];
// One permitted site each, repo-relative.
const ONLY_IN = [
  { name: 'fetch call', re: /\bfetch\s*\(/, home: 'frontend/src/lib/api.ts', bad: ['fetch(url)', 'await fetch (url, init)'] },
  { name: 'localStorage use', re: /\blocalStorage\b/, home: 'frontend/src/lib/persist.ts', bad: ["localStorage.setItem('k', v)"] },
];

/** How many JSX opening tags in `text` spread props (`{...x}`), and how many tags were read. */
function spreads(text) {
  const tags = openingTags(text);
  return { tags: tags.length, spread: tags.filter((t) => hasSpread(t.attrs)).length };
}
const SPREAD_BAD = ['<div {...p} />', '<Card id="a" {...rest}>x</Card>', '<Input { ...props } value={v} />', '<a href="#" {...{ target: t }}>'];

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
    for (const { name, re } of RULES) if (re.test(text)) out.push(`${f}: ${name}`);
    for (const { name, re, home } of ONLY_IN) if (re.test(text) && f !== home) out.push(`${f}: ${name}`);
    if (!isFeatureCode(f)) continue;
    const n = spreads(text);
    tags += n.tags;
    if (n.spread) out.push(`${f}: JSX spread props`);
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
  for (const { re, home } of ONLY_IN) assert.match(blankComments(read(home)), re, home);
});

// Counted at the check: every known-bad sample must be flagged by the very test the
// scan applies. A floor well under the sample count would let a deadened pattern pass.
test('every rule still flags each of its known-bad samples, alternative by alternative', () => {
  const missed = [];
  let flagged = 0;
  for (const { name, re, bad } of [...RULES, ...ONLY_IN]) {
    for (const sample of bad) (re.test(sample) ? flagged++ : missed.push(`${name}: ${sample}`));
  }
  for (const sample of SPREAD_BAD) (spreads(sample).spread === 1 ? flagged++ : missed.push(`JSX spread props: ${sample}`));
  assert.deepEqual(missed, []);
  const total = [...RULES, ...ONLY_IN].reduce((n, r) => n + r.bad.length, SPREAD_BAD.length);
  assert.equal(flagged, total);
  assert.ok(RULES.every((r) => r.bad.length > 0) && ONLY_IN.every((r) => r.bad.length > 0), 'every rule has a sample');
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
  'frontend/src/styles.css': '.x { font-style: italic; }\n.y { FONT-STYLE: normal; }',
};

test('each rule fires on every script type the bundle can contain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kanban-scan-'));
  try {
    for (const [rel, text] of Object.entries(FIXTURE)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    assert.deepEqual(violations(root).sort(), [
      'frontend/index.html: a style by any route (attribute, <style>, a style key, .style access)',
      'frontend/public/boot.js: raw-HTML, eval or cross-frame sink',
      'frontend/src/Card.tsx: fetch call',
      'frontend/src/Spread.tsx: JSX spread props',
      'frontend/src/Styled.jsx: a style by any route (attribute, <style>, a style key, .style access)',
      'frontend/src/View.jsx: expression-built link, source or form target',
      'frontend/src/k.ts: localStorage use',
      'frontend/src/lib/paint.js: a style by any route (attribute, <style>, a style key, .style access)',
      'frontend/src/lib/tint.ts: a style by any route (attribute, <style>, a style key, .style access)',
      'frontend/src/lib/x.js: raw-HTML, eval or cross-frame sink',
      'frontend/src/lib/y.mjs: root-relative /api literal',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
