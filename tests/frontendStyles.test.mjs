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
  const app = read('../frontend/app.js');
  const primaries = [...app.matchAll(/el\(\s*'button'\s*,\s*\{([^}]*)\}/g)]
    .map((m) => m[1])
    .filter((props) => /class:\s*'primary'/.test(props));
  assert.ok(primaries.length > 0, 'app.js renders no primary button');
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
