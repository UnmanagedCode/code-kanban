import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, listUiCode, read, blankComments, openingTags, attrValue, hasSpread } from './_sourceScan.mjs';

// The plan renderer: the one file allowed a content-built link, and only as `href={safeHref(x)}`.
const LINK_HOME = 'frontend/src/components/PlanMarkdown.tsx';

/** `word` as a regex source matching it in any letter case (HTML attribute names fold case). */
const anyCase = (word) => [...word].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join('');
// The attributes that load or navigate to a URL. `href` is listed apart: only it has a home exemption.
const URL_ATTRS = ['src', 'srcSet', 'action', 'formAction', 'xlinkHref'].map(anyCase).join('|');
// The exact sink shape, case-sensitive on purpose: `SafeHref(` is not the imported binding.
const SINK_CALL = String.raw`\s*=\s*\{\s*safeHref\s*\(\s*[\w$.]+\s*\)\s*\}`;

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
    re: /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write|dangerouslySetInnerHTML|\beval\s*\(|new\s+Function\b|\bDOMParser\b|createContextualFragment|\bsetAttribute\s*\(|location\.hash\s*=|\bpushState\b|window\.parent\b|code-conductor:|location\s*\.\s*(?:href|assign|replace)\s*(?:\|\||\?\?)?=|location\s*\.\s*(?:assign|replace)\s*\(|\b(?:window|document|self|top|globalThis)\s*\.\s*location\s*(?:\|\||\?\?)?=(?![=>])|(?:^|[^\w.$])location\s*(?:\|\||\?\?)?=(?![=>])|\[\s*['"`]location['"`]\s*\]\s*(?:\|\||\?\?)?=(?![=>])|document\s*\.\s*cookie|\bdocument\s*\[\s*['"`]cookie['"`]\s*\]|\bparent\s*\.\s*postMessage|\bsetAttributeNS\s*\(|\binsertAdjacentElement\s*\(/,
    bad: [
      'el.innerHTML = html', 'el.outerHTML = html', "el.insertAdjacentHTML('beforeend', h)", 'document.write(h)',
      '<div dangerouslySetInnerHTML={{ __html: h }} />', 'eval(code)', "new Function('return 1')", 'new DOMParser()',
      'range.createContextualFragment(h)', "el.setAttribute('href', u)", "location.hash = '#x'", "history.pushState(null, '', u)",
      'window.parent.postMessage(m)', "localStorage.getItem('code-conductor:theme')",
      // Navigation is not governed by the CSP: a content-built URL there is a javascript: link.
      'location.href = u', 'window.location . assign = f', 'location.replace = f', 'location.assign(u)', 'window.location.replace (u)',
      // Assigning the location object itself navigates too, through any global that holds it.
      'window.location = u', 'document.location=u', 'self . location = u', 'top.location  =u', 'globalThis\t.location = u',
      // ...bare, bracketed, and as a logical compound assignment.
      'location = u', "window['location'] = u", 'window.location ||= u', 'top.location ??= u', 'location.href ??= u',
      'const c = document.cookie', 'parent.postMessage(m, origin)', "el.setAttributeNS(null, 'href', u)",
      // The bracketed spellings of document.cookie, in each quote style.
      "document['cookie']", 'document [ "cookie" ]', 'document[`cookie`]',
      "el.insertAdjacentElement('afterend', node)",
    ],
  },
  {
    name: 'expression-built link, source or form target',
    // Attribute names in any letter case: the DOM folds `HREF` to a live href.
    re: new RegExp(String.raw`\b(?:${anyCase('href')}|${URL_ATTRS})\s*=\s*\{`),
    bad: [
      '<a href={u}>', '<img src={u} />', '<img srcSet={u} />', '<form action={u}>', '<button formAction={u}>', '<use xlinkHref={u} />',
      '<a HREF={u}>', '<a Href={u}>', '<img SRC={u} />', '<img SRCSET={u} />', '<form ACTION={u}>', '<button FORMACTION={u}>', '<use XLINKHREF={u} />',
    ],
    // In LINK_HOME alone, an href that is exactly `{safeHref(<one name>)}` is exempt; every
    // other expression attribute, and every other href shape, still trips.
    home: LINK_HOME,
    homeRe: new RegExp(String.raw`\b(?:${anyCase('href')}(?!${SINK_CALL})|${URL_ATTRS})\s*=\s*\{`),
    homeBad: [
      '<a href={u}>', '<a href={ safe(u) }>', '<a href={safeHref(u) || u}>', '<a href={safeHref(u, base)}>', '<a href={SafeHref(u)}>',
      '<img src={safeHref(u)} />', '<img srcSet={u} />', '<form action={u}>', '<button formAction={u}>', '<use xlinkHref={u} />',
      '<a HREF={u}>', '<img SRC={safeHref(u)} />', '<img SrcSet={u} />', '<form Action={u}>', '<button FormAction={u}>', '<use XlinkHref={u} />',
    ],
    homeOk: ['<a href={safeHref(n.href)}>', '<a href={ safeHref( node.href ) }>'],
  },
  {
    // React elements are built only as JSX, where the attribute rules can read them: a props
    // object (`createElement('a', { href: u })`, `jsx(…)`, `cloneElement(el, { href: u })`) carries
    // any URL past them, and React refuses only `javascript:` on a lowercase `href`. The names are
    // denied outright, a string or a member access included (`React['createElement']`), as is the
    // runtime module they come from, and a URL property written onto an element through a ref.
    name: 'element built or URL set outside JSX',
    re: /\b(?:createElement|cloneElement|jsxs?|jsxDEV)\b|react\/jsx-(?:dev-)?runtime|\.\s*(?:href|src|srcset|action|formAction)\s*=(?![=>])/i,
    bad: [
      "React.createElement('a', { href: u })", "createElement('a', { href: u })", "document.createElement('a')",
      'cloneElement(el, { href: u })', "jsx('a', { href: u })", "jsxs('a', { href: u, children: [x] })", "jsxDEV('a', { href: u })",
      "React['createElement']('a', p)", "import { jsx as h } from 'react/jsx-runtime';", "import { jsxDEV } from 'react/jsx-dev-runtime';",
      'ref.current.href = u', 'img.src = u', 'img.srcset = u', 'form.action = u', 'btn.formAction = u', 'a . HREF = u',
    ],
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

/**
 * What LINK_HOME's text breaks. It must import `safeHref` (unaliased) from the lib, and every other
 * `safeHref` in it must be the call at an href sink: any further occurrence (a declaration, an alias,
 * a parameter or destructured parameter that shadows the import, a bare reference) is a binding the
 * sink could resolve to instead, or the import escaping the sink.
 */
function linkHomeOffences(text) {
  const out = [];
  const imports = [...text.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"]@\/lib\/planMarkdown['"]/g)];
  const imported = imports.flatMap((m) => m[1].split(',').map((x) => x.trim())).filter((x) => x === 'safeHref').length;
  if (!imported) out.push('safeHref not imported from @/lib/planMarkdown');
  const sinks = text.match(new RegExp(String.raw`\b${anyCase('href')}\s*=\s*\{\s*safeHref\s*\(`, 'g'))?.length ?? 0;
  const named = text.match(/\bsafeHref\b/g)?.length ?? 0;
  if (named > imported + sinks) out.push('safeHref named outside its import and the href sink');
  return out;
}
const LINK_HOME_BAD = [
  "import { safeHref } from './planMarkdown';",
  "import { parsePlan } from '@/lib/planMarkdown';",
  "import { safeHref as s } from '@/lib/planMarkdown';",
  "import { safeHref } from '@/lib/planMarkdown';\nconst safeHref = (u) => u;",
  "import { safeHref } from '@/lib/planMarkdown';\nlet safeHref;",
  "import { safeHref } from '@/lib/planMarkdown';\nvar safeHref;",
  "import { safeHref } from '@/lib/planMarkdown';\nfunction safeHref(u) { return u; }",
  "import { safeHref } from '@/lib/planMarkdown';\nclass safeHref {}",
  "import { safeHref } from '@/lib/planMarkdown';\nimport { id as safeHref } from './x';",
  // A parameter shadowing the import: plain, destructured, arrow, bare arrow, and a catch binding.
  "import { safeHref } from '@/lib/planMarkdown';\nfunction P(safeHref, u) { return <a href={safeHref(u)} />; }",
  "import { safeHref } from '@/lib/planMarkdown';\nfunction Shadowed({ safeHref, u }) { return <a href={safeHref(u)} />; }",
  "import { safeHref } from '@/lib/planMarkdown';\nconst A = (safeHref, u) => <a href={safeHref(u)} />;",
  "import { safeHref } from '@/lib/planMarkdown';\nconst B = safeHref => <a href={safeHref(u)} />;",
  "import { safeHref } from '@/lib/planMarkdown';\ntry { f(); } catch (safeHref) { g(<a href={safeHref(u)} />); }",
  // The import used anywhere but the sink.
  "import { safeHref } from '@/lib/planMarkdown';\nconst f = safeHref;",
];

/** Every `<a>` in `text` that does not open in a new context with no opener and no referrer, by string literal. */
function anchorOffences(text) {
  const tags = openingTags(text, ['a']);
  return {
    anchors: tags.length,
    bad: tags.filter((t) => attrValue(t.attrs, 'target') !== '_blank' || attrValue(t.attrs, 'rel') !== 'noopener noreferrer').length,
  };
}
const ANCHOR_BAD = [
  '<a href="https://x.test">x</a>', '<a target="_blank">x</a>', '<a rel="noopener noreferrer">x</a>',
  '<a target="_blank" rel="noopener">x</a>', '<a target={t} rel="noopener noreferrer">x</a>',
  '<a target="_blank" rel={r}>x</a>', '<a target="_self" rel="noopener noreferrer">x</a>',
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

const ANCHOR_RULE = 'a link without target="_blank" rel="noopener noreferrer"';

/** `file: rule` for every rule a file under `root` breaks, and how many JSX tags and anchors the feature-code rules read. */
function scan(root) {
  const out = [];
  let tags = 0;
  let anchors = 0;
  for (const f of uiFiles(root)) {
    const text = f.endsWith('.html') || f.endsWith('.css') ? read(f, root) : blankComments(read(f, root));
    for (const { name, re, home, homeRe } of RULES) if ((f === home ? homeRe : re).test(text)) out.push(`${f}: ${name}`);
    for (const { name, re, home } of ONLY_IN) if (re.test(text) && f !== home) out.push(`${f}: ${name}`);
    if (f === LINK_HOME) for (const what of linkHomeOffences(text)) out.push(`${f}: link home: ${what}`);
    if (!isFeatureCode(f)) continue;
    const n = spreads(text);
    tags += n.tags;
    if (n.spread) out.push(`${f}: JSX spread props`);
    const a = anchorOffences(text);
    anchors += a.anchors;
    if (a.bad) out.push(`${f}: ${ANCHOR_RULE}`);
  }
  return { out, tags, anchors };
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
  const { out, tags, anchors } = scan(undefined);
  assert.deepEqual(out, []);
  assert.ok(tags >= MIN_FEATURE_JSX_TAGS, `the spread rule read only ${tags} JSX tags in feature code`);
  assert.ok(anchors >= 1, 'the anchor rule read no <a> in feature code');
});

test('fetch and localStorage each still have their one site', () => {
  for (const { re, home } of ONLY_IN) assert.match(blankComments(read(home)), re, home);
});

test('the plan renderer is still the one link sink, its href routed through the imported safeHref', () => {
  const text = blankComments(read(LINK_HOME));
  assert.match(text, /<a\s+href=\{safeHref\(node\.href\)\}/);
  assert.deepEqual(linkHomeOffences(text), []);
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
  const homed = RULES.filter((r) => r.home);
  for (const { name, homeRe, homeBad } of homed) {
    for (const sample of homeBad) (homeRe.test(sample) ? flagged++ : missed.push(`${name} (in its home): ${sample}`));
  }
  for (const sample of LINK_HOME_BAD) (linkHomeOffences(sample).length ? flagged++ : missed.push(`link home: ${sample}`));
  for (const sample of ANCHOR_BAD) (anchorOffences(sample).bad === 1 ? flagged++ : missed.push(`${ANCHOR_RULE}: ${sample}`));
  assert.deepEqual(missed, []);
  const total = [...RULES, ...ONLY_IN].reduce((n, r) => n + r.bad.length, SPREAD_BAD.length)
    + homed.reduce((n, r) => n + r.homeBad.length, 0) + LINK_HOME_BAD.length + ANCHOR_BAD.length;
  assert.equal(flagged, total);
  assert.ok(RULES.every((r) => r.bad.length > 0) && ONLY_IN.every((r) => r.bad.length > 0), 'every rule has a sample');
  assert.ok(homed.length === 1 && homed.every((r) => r.homeBad.length > 0), 'the link rule keeps its home variant');
});

test('the link home exempts only the exact safeHref href shape, which the general rule still flags', () => {
  for (const { name, re, homeRe, homeOk } of RULES.filter((r) => r.home)) {
    for (const sample of homeOk) {
      assert.equal(homeRe.test(sample), false, `${name} (in its home) flags ${sample}`);
      assert.equal(re.test(sample), true, `${name} misses ${sample} outside its home`);
    }
  }
  assert.deepEqual(linkHomeOffences("import { parsePlan, safeHref } from '@/lib/planMarkdown';"), []);
  assert.deepEqual(linkHomeOffences("import { safeHref } from '@/lib/planMarkdown';\nconst L = ({ n }) => <><a href={safeHref(n.href)} /><a href={ safeHref(n.alt) } /></>;"), []);
  assert.deepEqual(anchorOffences('<a href={safeHref(n.href)} target="_blank" rel="noopener noreferrer">x</a>'), { anchors: 1, bad: 0 });
});

// A fixture tree: one file per script type the bundle can contain, each breaking a
// rule; plus the shapes that must NOT trip one (a comment, a spread inside the copied
// components/ui/, `font-style` in CSS).
const FIXTURE = {
  'frontend/index.html': '<!doctype html><div style="x"></div>',
  'frontend/public/boot.js': 'document.write("<b>x</b>");',
  'frontend/src/lib/x.js': 'export const put = (el, html) => { el.innerHTML = html; };',
  'frontend/src/lib/y.mjs': "export const u = '/api/board';",
  'frontend/src/lib/nav.mts': 'export const go = (u: string) => { location.assign(u); };',
  'frontend/src/lib/cookie.cts': 'export const c = () => document.cookie;',
  'frontend/src/lib/legacy.cjs': "module.exports = (el, h) => el.insertAdjacentHTML('beforeend', h);",
  'frontend/src/View.jsx': 'export const V = ({ u }) => <a href={u}>x</a>;',
  'frontend/src/Card.tsx': 'export const C = () => <p>{fetch("api/x")}</p>;',
  'frontend/src/k.ts': "localStorage.setItem('k', 'v');",
  'frontend/src/clean.ts': '// innerHTML in a comment is prose, not code\nexport const ok = 1;',
  // Comparing or reading the location — or naming a parameter `location` — is not a navigation.
  'frontend/src/lib/where.ts': [
    'export const framed = () => window.location === top.location;',
    'export const here = (location: Location) => location.href;',
    "export const same = (l: Location) => location == l || window['location'] !== l;",
    'export const pick = (location?: Location) => location;',
  ].join('\n'),
  'frontend/src/Styled.jsx': "export const S = (v) => React.createElement('div', { style: v.css });",
  'frontend/src/lib/paint.js': 'export const paint = (el, v) => { el.style = v; };',
  'frontend/src/lib/tint.ts': 'export const tint = (el: HTMLElement, v: string) => { el.style.color = v; };',
  'frontend/src/Spread.tsx': 'export const P = (p: object) => <div className="x" {...p} />;',
  'frontend/src/components/ui/slot.tsx': 'export const Slot = (p: object) => <span {...p} />;',
  // The link home with a bare href, beside the exempt shape over a local, unimported safeHref.
  [LINK_HOME]: [
    "import { safeHref } from '@/lib/planMarkdown';",
    'const S = ({ safeHref, u }) => <a href={safeHref(u)} target="_blank" rel="noopener noreferrer">s</a>;',
    'export const L = ({ u }) => <><a href={u} target="_blank" rel="noopener noreferrer">x</a>'
      + '<a href={safeHref(u)} target="_blank" rel="noopener noreferrer">y</a></>;',
  ].join('\n'),
  // The exempt shape outside the home is still an expression-built link.
  'frontend/src/Elsewhere.tsx': "import { safeHref } from '@/lib/planMarkdown';\n"
    + 'export const E = ({ u }) => <a href={safeHref(u)} target="_blank" rel="noopener noreferrer">x</a>;',
  'frontend/src/NoRel.tsx': 'export const N = () => <a href="https://x.test" target="_blank">x</a>;',
  // An attribute name in upper case is still an expression-built link.
  'frontend/src/Upper.tsx': 'export const U = ({ u }) => <a HREF={u} target="_blank" rel="noopener noreferrer">x</a>;',
  // An element built from a props object, and a URL written through a ref.
  'frontend/src/lib/build.ts': "import { cloneElement } from 'react';\nexport const b = (el, u) => cloneElement(el, { href: u });",
  'frontend/src/lib/refWrite.js': 'export const w = (r, u) => { r.current.href = u; };',
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
      'frontend/src/Elsewhere.tsx: expression-built link, source or form target',
      `frontend/src/NoRel.tsx: ${ANCHOR_RULE}`,
      'frontend/src/Spread.tsx: JSX spread props',
      'frontend/src/Styled.jsx: a style by any route (attribute, <style>, a style key, .style access)',
      'frontend/src/Styled.jsx: element built or URL set outside JSX',
      'frontend/src/Upper.tsx: expression-built link, source or form target',
      `frontend/src/View.jsx: ${ANCHOR_RULE}`,
      'frontend/src/View.jsx: expression-built link, source or form target',
      'frontend/src/components/PlanMarkdown.tsx: expression-built link, source or form target',
      'frontend/src/components/PlanMarkdown.tsx: link home: safeHref named outside its import and the href sink',
      'frontend/src/k.ts: localStorage use',
      'frontend/src/lib/build.ts: element built or URL set outside JSX',
      'frontend/src/lib/cookie.cts: raw-HTML, eval or cross-frame sink',
      'frontend/src/lib/legacy.cjs: raw-HTML, eval or cross-frame sink',
      'frontend/src/lib/nav.mts: raw-HTML, eval or cross-frame sink',
      'frontend/src/lib/paint.js: a style by any route (attribute, <style>, a style key, .style access)',
      'frontend/src/lib/refWrite.js: element built or URL set outside JSX',
      'frontend/src/lib/tint.ts: a style by any route (attribute, <style>, a style key, .style access)',
      'frontend/src/lib/x.js: raw-HTML, eval or cross-frame sink',
      'frontend/src/lib/y.mjs: root-relative /api literal',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
