import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listFiles, read, blankComments, openingTags, attrValue } from './_sourceScan.mjs';

// Host-theme guards: the page loads code-conductor's bridge and theme sheet in the
// order the host contract needs, keeps a standalone fallback that covers every
// token it maps, colours only through those tokens, never toggles the theme
// itself, and keeps the default button variant for a form's submit. Read as text:
// `npm test` has no DOM.

const html = read('frontend/index.html');
const indexCss = read('frontend/src/index.css');
const fallback = read('frontend/src/cc-theme-fallback.css');
const themeInit = read('frontend/public/theme-init.js');

const SRC = listFiles('frontend/src', ['.ts', '.tsx', '.css']);
const FEATURE_TSX = listFiles('frontend/src', ['.tsx']).filter((f) => !f.startsWith('frontend/src/components/ui/'));

// Liveness floors: a scanner that reads nothing passes everything. Sized well under
// the real counts so ordinary churn never trips them.
const MIN_SRC_FILES = 20;
const MIN_FEATURE_TSX = 12;
const MIN_BUTTONS = 8;

test('the scanners read the source tree', () => {
  assert.ok(SRC.length >= MIN_SRC_FILES, `read ${SRC.length} source files`);
  assert.ok(FEATURE_TSX.length >= MIN_FEATURE_TSX, `read ${FEATURE_TSX.length} feature .tsx files`);
});

test('<head> opens with the blocking bridge, then the theme sheet, then theme-init.js', () => {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
  const tags = [...head.matchAll(/<(meta|script|link)\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/^<meta charset/i.test(t));
  assert.match(tags[0], /^<script src="\/pluginBridge\.js"/);
  assert.doesNotMatch(tags[0], /\b(defer|async|type\s*=)/);
  assert.match(tags[1], /^<link rel="stylesheet" href="\/pluginTheme\.css"/);
  assert.match(tags[2], /^<script src="theme-init\.js"/);
});

test('index.html names no root-relative URL besides the two host URLs', () => {
  const urls = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 4);
  const rooted = urls.filter((u) => u.startsWith('/'));
  assert.deepEqual(rooted.sort(), ['/pluginBridge.js', '/pluginTheme.css']);
});

test('theme-init.js leaves an embedded page to the bridge and follows the OS theme standalone', () => {
  const code = blankComments(themeInit);
  assert.match(code, /if\s*\(\s*root\.hasAttribute\(\s*'data-cc-theme'\s*\)\s*\)\s*return\s*;/);
  assert.match(code, /matchMedia\(\s*'\(prefers-color-scheme: dark\)'\s*\)/);
  assert.match(code, /addEventListener\(\s*'change'/);
  assert.match(code, /classList\.toggle\(\s*'dark'\s*,\s*mq\.matches\s*\)/);
});

// The :root / .dark blocks of the fallback, comments stripped.
const fallbackCode = fallback.replace(/\/\*[\s\S]*?\*\//g, '');
const block = (sel) => {
  const m = fallbackCode.match(new RegExp(`(?:^|[\\s}])${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
};
const declared = (body) => new Set([...(body ?? '').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

test('the standalone fallback is one @layer base block holding :root and .dark', () => {
  const trimmed = fallbackCode.trim();
  assert.match(trimmed, /^@layer base\s*\{/);
  assert.ok(trimmed.endsWith('}'));
  assert.equal((trimmed.match(/@layer\b/g) ?? []).length, 1);
  assert.ok(block(':root'), 'no :root block');
  assert.ok(block('.dark'), 'no .dark block');
});

test('every token index.css maps is declared by the fallback, and every colour token in .dark too', () => {
  const theme = indexCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)[1];
  const mapped = [...theme.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
  assert.ok(mapped.length >= 20, `mapped only ${mapped.length}`);
  const root = declared(block(':root'));
  const dark = declared(block('.dark'));
  for (const t of mapped) assert.ok(root.has(t), `${t} missing from the fallback :root`);
  const colours = [...theme.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g)].map((m) => m[1]);
  for (const t of colours) assert.ok(dark.has(t), `${t} missing from the fallback .dark`);
});

test('index.css imports Tailwind, tw-animate-css and the fallback, and keys dark: on the .dark class', () => {
  assert.match(indexCss, /@import\s+'tailwindcss';/);
  assert.match(indexCss, /@import\s+'tw-animate-css';/);
  assert.match(indexCss, /@import\s+'\.\/cc-theme-fallback\.css';/);
  assert.match(indexCss, /@custom-variant dark \(&:is\(\.dark \*\)\);/);
});

// Literal colours, in the plugin's own code: hex, the CSS colour functions, and
// Tailwind's built-in palette utilities. The copied components/ui/ files and the
// fallback snapshot are exempt.
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/;
const PALETTE_UTILITY = /\b(?:bg|text|border|ring|outline|fill|stroke|shadow|from|to|via|decoration|divide|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)\b/;

test('no literal colour in the plugin’s own frontend code: colours come from the host tokens', () => {
  const own = SRC.filter((f) => !f.startsWith('frontend/src/components/ui/') && f !== 'frontend/src/cc-theme-fallback.css');
  assert.ok(own.length >= MIN_FEATURE_TSX, `scanned ${own.length}`);
  for (const f of own) {
    const text = f.endsWith('.css') ? read(f).replace(/\/\*[\s\S]*?\*\//g, '') : blankComments(read(f));
    text.split('\n').forEach((line, i) => {
      assert.doesNotMatch(line, COLOUR_LITERAL, `${f}:${i + 1}: literal colour`);
      assert.doesNotMatch(line, PALETTE_UTILITY, `${f}:${i + 1}: palette utility`);
    });
  }
});

test('nothing but theme-init.js writes the dark class or data-cc-theme: no theme toggle of our own', () => {
  const files = [...listFiles('frontend/src', ['.ts', '.tsx']), 'frontend/index.html'];
  for (const f of files) {
    const code = f.endsWith('.html') ? read(f) : blankComments(read(f));
    assert.doesNotMatch(code, /classList\s*\.\s*\w+\(\s*['"`]dark['"`]/, `${f} writes the dark class`);
    assert.doesNotMatch(code, /setAttribute\(\s*['"`]data-cc-theme/, `${f} writes data-cc-theme`);
    assert.doesNotMatch(code, /className\s*=\s*['"`][^'"`]*\bdark\b/, `${f} sets the dark class`);
  }
});

test('every button in feature code states its type, and a default-variant Button is a form submit', () => {
  let buttons = 0;
  for (const f of FEATURE_TSX) {
    for (const tag of openingTags(blankComments(read(f)), ['Button', 'button'])) {
      buttons++;
      const type = attrValue(tag.attrs, 'type');
      assert.ok(typeof type === 'string' && type !== '', `${f}: <${tag.name}${tag.attrs}> has no explicit type`);
      if (tag.name !== 'Button') continue;
      const variant = attrValue(tag.attrs, 'variant');
      if (variant === undefined || variant === 'default' || variant === 'destructive') {
        assert.equal(type, 'submit', `${f}: a ${variant ?? 'default'}-variant Button is the form's commit, so type="submit": <Button${tag.attrs}>`);
      }
    }
  }
  assert.ok(buttons >= MIN_BUTTONS, `found only ${buttons} buttons`);
});
