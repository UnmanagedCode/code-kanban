// Pins: frontend/styles.css is dark-only and snaps onto code-conductor's shell
// palette — the host's :root token names and values, its control literals, its
// primary-submit and quiet-button rules and its focus ring. Reads the stylesheet
// as text: there is no DOM in `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const css = read('../frontend/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
const root = rootMatch ? rootMatch[1] : '';
const declared = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// Drops every @media {…} block (brace-depth scan), so only top-level rules remain.
function stripMedia(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@media', i);
    if (at === -1) { out += text.slice(i); break; }
    out += text.slice(i, at);
    let j = text.indexOf('{', at);
    let depth = 1;
    for (j += 1; j < text.length && depth > 0; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
    }
    i = j;
  }
  return out;
}

const rules = [...stripMedia(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
  body: m[2],
}));

// Property → value, merged across every top-level rule listing exactly `selector`.
function decls(selector) {
  const matching = rules.filter((r) => r.selectors.includes(selector));
  assert.ok(matching.length > 0, `styles.css has no rule for ${selector}`);
  const map = new Map();
  for (const { body } of matching) {
    for (const d of body.split(';')) {
      const c = d.indexOf(':');
      if (c === -1) continue;
      map.set(d.slice(0, c).trim(), d.slice(c + 1).trim().replace(/\s+/g, ' '));
    }
  }
  return map;
}

function assertDecls(selector, expected) {
  const got = decls(selector);
  for (const [prop, value] of Object.entries(expected)) {
    assert.equal(got.get(prop), value, `${selector} { ${prop} }`);
  }
}

// JS scanning for the primary-button test. frontend/app.js has no regex
// literals, so skipping strings and comments is enough to match brackets.
const CLOSERS = { '(': ')', '{': '}', '[': ']' };
const isQuote = (ch) => ch === "'" || ch === '"' || ch === '`';

// Index just past the string literal opening at `i` (template ${…} included).
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (q === '`' && src.startsWith('${', j)) { j = matchClose(src, j + 1) - 1; continue; }
    if (src[j] === q) return j + 1;
  }
  throw new Error(`unterminated string at ${i}`);
}

// Index just past the bracket matching the one at `open`.
function matchClose(src, open) {
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (isQuote(ch)) { i = skipString(src, i) - 1; continue; }
    if (CLOSERS[ch]) stack.push(CLOSERS[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') {
      assert.equal(ch, stack.pop(), `unbalanced ${ch} at ${i}`);
      if (stack.length === 0) return i + 1;
    }
  }
  throw new Error(`no closer for ${src[open]} at ${open}`);
}

// `src` with every comment blanked to spaces, so indices are preserved.
function blankComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    if (isQuote(src[i])) { const j = skipString(src, i); out += src.slice(i, j); i = j; continue; }
    let stop = -1;
    if (src.startsWith('//', i)) stop = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    else if (src.startsWith('/*', i)) stop = src.indexOf('*/', i) + 2;
    if (stop === -1) { out += src[i]; i++; continue; }
    out += src.slice(i, stop).replace(/[^\n]/g, ' ');
    i = stop;
  }
  return out;
}

// An object literal's own properties as text: nested brackets dropped, strings kept.
function topLevel(src, open, close) {
  let out = '';
  for (let i = open + 1; i < close - 1;) {
    if (isQuote(src[i])) { const j = skipString(src, i); out += src.slice(i, j); i = j; continue; }
    if (CLOSERS[src[i]]) { i = matchClose(src, i); out += ' '; continue; }
    out += src[i]; i++;
  }
  return out;
}

// `primary` as one class among any others in a class string.
const PRIMARY_CLASS = /class:\s*(['"`])(?:[^'"`]*\s)?primary(?:\s[^'"`]*)?\1/g;

test(':root block exists', () => {
  assert.ok(rootMatch, 'styles.css has no :root block');
});

test('dark-only: no prefers-color-scheme query, :root declares color-scheme: dark', () => {
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.match(root, /(^|[;\s])color-scheme\s*:\s*dark\s*(;|$)/);
});

test(':root declares exactly the host shell tokens plus the categorical lane hues', () => {
  const shell = ['--bg', '--panel', '--panel-2', '--text', '--muted', '--accent', '--green', '--amber', '--red', '--border'];
  const lanes = ['--triage', '--backlog', '--todo', '--progress', '--done'];
  assert.deepEqual([...declared].sort(), [...shell, ...lanes].sort());
});

test("shell tokens carry code-conductor's :root values", () => {
  // Copied from the :root block of code-conductor's public/styles.css (the host
  // injects no theme into the plugin iframe). Re-copy if the host changes.
  assertDecls(':root', {
    '--bg': '#0f1117',
    '--panel': '#151823',
    '--panel-2': '#1d2130',
    '--text': '#d8dae6',
    '--muted': '#8a90a3',
    '--accent': '#6ea8ff',
    '--green': '#4ade80',
    '--amber': '#f59e0b',
    '--red': '#f87171',
    '--border': '#232838',
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'font-size': '14px',
  });
});

test('every var(--name) used is declared on :root', () => {
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 0);
  for (const name of used) assert.ok(declared.has(name), `var(${name}) is not declared on :root`);
});

test("no hex colour outside :root except the host's own control literals", () => {
  const allowed = new Set(['#262b3d', '#8cb9ff', '#0a0c12']);
  const outside = css.replace(/:root\s*\{[^}]*\}/, '');
  for (const [hex] of outside.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    assert.ok(allowed.has(hex.toLowerCase()), `stray hex colour ${hex} outside :root`);
  }
});

test('the accent-filled primary copies the host submit, including its disabled swap', () => {
  assertDecls('button.primary', {
    background: 'var(--accent)', color: '#0a0c12', 'border-color': 'var(--accent)', 'font-weight': '600',
  });
  assertDecls('button.primary:hover:not(:disabled)', { background: '#8cb9ff', 'border-color': '#8cb9ff' });
  assertDecls('button.primary:disabled', {
    background: 'var(--panel-2)', color: 'var(--muted)', 'border-color': 'var(--border)', 'font-weight': '400',
  });
  assertDecls('button:disabled', { opacity: '.5', cursor: 'not-allowed' });
});

test('only submit buttons carry the primary class', () => {
  const app = blankComments(read('../frontend/app.js'));
  // The own props of every el('button', {…}) call, brace-balanced.
  const buttonProps = [...app.matchAll(/\bel\(\s*'button'\s*,\s*\{/g)].map((m) => {
    const open = m.index + m[0].length - 1;
    return topLevel(app, open, matchClose(app, open));
  });
  const count = (text) => (text.match(PRIMARY_CLASS) ?? []).length;
  const primaries = buttonProps.filter((props) => count(props) > 0);
  assert.ok(primaries.length > 0, 'app.js renders no primary button');
  // Every primary class in app.js sits in some button's own props, so none escapes the scan.
  assert.equal(primaries.reduce((n, props) => n + count(props), 0), count(app), "a primary class outside an el('button') props object");
  for (const props of primaries) assert.match(props, /type:\s*'submit'/, `primary button is not a submit: {${props}}`);
  assert.doesNotMatch(read('../frontend/index.html'), /class="primary"/);
});

test('quiet buttons are panel-2 with a border, the host hover and a 6px radius', () => {
  assertDecls('button', { background: 'var(--panel-2)', border: '1px solid var(--border)', 'border-radius': '6px' });
  assertDecls('button:hover:not(:disabled)', { background: '#262b3d' });
  assertDecls('.overlay-close:hover:not(:disabled)', { background: 'none' });
});

test('controls share the host focus ring', () => {
  for (const sel of ['input:focus', 'select:focus', 'textarea:focus', 'button:focus-visible', '.card:focus-visible']) {
    assertDecls(sel, { outline: '2px solid var(--accent)', 'outline-offset': '-1px' });
  }
});

test('meaningful tints and urgent priorities use host tokens', () => {
  assertDecls('.epic-row button.ghost', { color: 'var(--accent)', 'border-color': 'var(--accent)' });
  assertDecls('button.danger', { color: 'var(--red)', 'border-color': 'var(--red)' });
  assertDecls('.badge.prio-critical', { color: 'var(--red)', 'border-color': 'var(--red)' });
  assertDecls('.badge.prio-high', { color: 'var(--amber)', 'border-color': 'var(--amber)' });
});
