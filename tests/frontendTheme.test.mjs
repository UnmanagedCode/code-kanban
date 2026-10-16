import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, listUiCode, read, blankComments, openingTags, attrValue } from './_sourceScan.mjs';

// Host-theme guards: the page loads code-conductor's bridge and theme sheet in the
// order the host contract needs, keeps a standalone fallback that covers every
// token it maps, colours only through those tokens, never toggles the theme
// itself, and keeps the default button variant for a form's submit. Read as text:
// `npm test` has no DOM.

const html = read('frontend/index.html');
const indexCss = read('frontend/src/index.css');
const fallback = read('frontend/src/cc-theme-fallback.css');
const themeInit = read('frontend/public/theme-init.js');

const isOwn = (f) => !f.startsWith('frontend/src/components/ui/');
/** Every script and stylesheet under frontend/src (relative to `root`). */
const srcFiles = (root) => [...listUiCode('frontend/src', root), ...listFiles('frontend/src', ['.css'], root)];
/** The plugin's own scripts: frontend/src outside the copied components/ui/. */
const featureCode = (root) => listUiCode('frontend/src', root).filter(isOwn);
const SRC = srcFiles();
const FEATURE_CODE = featureCode();

// Liveness floors: a scanner that reads nothing passes everything. Sized well under
// the real counts so ordinary churn never trips them.
const MIN_SRC_FILES = 20;
const MIN_FEATURE_CODE = 12;
const MIN_BUTTONS = 8;

test('the scanners read the source tree', () => {
  assert.ok(SRC.length >= MIN_SRC_FILES, `read ${SRC.length} source files`);
  assert.ok(FEATURE_CODE.length >= MIN_FEATURE_CODE, `read ${FEATURE_CODE.length} feature script files`);
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

/** What a line breaks: `literal colour` and/or `palette utility`. */
const colourHits = (line) => [
  ...(COLOUR_LITERAL.test(line) ? ['literal colour'] : []),
  ...(PALETTE_UTILITY.test(line) ? ['palette utility'] : []),
];

/** `file:line: what` for every literal colour in the plugin's own code under `root`. */
function colourOffences(root) {
  const out = [];
  const own = srcFiles(root).filter((f) => isOwn(f) && f !== 'frontend/src/cc-theme-fallback.css');
  for (const f of own) {
    const text = f.endsWith('.css') ? read(f, root).replace(/\/\*[\s\S]*?\*\//g, '') : blankComments(read(f, root));
    text.split('\n').forEach((line, i) => {
      for (const what of colourHits(line)) out.push(`${f}:${i + 1}: ${what}`);
    });
  }
  return { scanned: own.length, out };
}

// Theme writes only theme-init.js may make.
const TOGGLES = [
  { what: 'writes the dark class', re: /classList\s*\.\s*\w+\(\s*['"`]dark['"`]/ },
  { what: 'writes data-cc-theme', re: /setAttribute\(\s*['"`]data-cc-theme/ },
  { what: 'sets the dark class', re: /className\s*=\s*['"`][^'"`]*\bdark\b/ },
];

/** `file: what` for every write of the dark class or data-cc-theme outside theme-init.js. */
function toggleOffences(root) {
  const out = [];
  for (const f of [...listUiCode('frontend/src', root), ...listFiles('frontend/index.html', ['.html'], root)]) {
    const code = f.endsWith('.html') ? read(f, root) : blankComments(read(f, root));
    for (const { what, re } of TOGGLES) if (re.test(code)) out.push(`${f}: ${what}`);
  }
  return out;
}

/** Buttons in feature code with no explicit type, or a default-variant Button that is not a submit. */
function buttonOffences(root) {
  const out = [];
  let buttons = 0;
  for (const f of featureCode(root)) {
    for (const tag of openingTags(blankComments(read(f, root)), ['Button', 'button'])) {
      buttons++;
      const type = attrValue(tag.attrs, 'type');
      if (typeof type !== 'string' || type === '') { out.push(`${f}: <${tag.name}> has no explicit type`); continue; }
      if (tag.name !== 'Button') continue;
      const variant = attrValue(tag.attrs, 'variant');
      if ((variant === undefined || variant === 'default' || variant === 'destructive') && type !== 'submit') {
        out.push(`${f}: a ${variant ?? 'default'}-variant Button is the form's commit, so type="submit"`);
      }
    }
  }
  return { buttons, out };
}

test('no literal colour in the plugin’s own frontend code: colours come from the host tokens', () => {
  const { scanned, out } = colourOffences();
  assert.ok(scanned >= MIN_FEATURE_CODE, `scanned ${scanned}`);
  assert.deepEqual(out, []);
});

test('nothing but theme-init.js writes the dark class or data-cc-theme: no theme toggle of our own', () => {
  assert.deepEqual(toggleOffences(), []);
});

test('every button in feature code states its type, and a default-variant Button is a form submit', () => {
  const { buttons, out } = buttonOffences();
  assert.deepEqual(out, []);
  assert.ok(buttons >= MIN_BUTTONS, `found only ${buttons} buttons`);
});

// Known-bad samples, at least one per alternative of each pattern: every hex length
// and colour function, every utility prefix and every palette name. Run through the
// same check the scan uses, counted at the check, so a pattern that stops matching
// (or loses an alternative) fails although the clean real tree still reads as clean.
const COLOUR_BAD = [
  "const c = '#f00'", "const c = '#ff0000'", "const c = '#ff000080'", 'rgb(1 2 3)', 'rgba(1, 2, 3, .5)', 'hsl(1 2% 3%)',
  'hsla(1, 2%, 3%, .5)', 'oklch(0.5 0.1 30)', 'oklab(0.5 0.1 0.1)', 'lab(50% 0 0)', 'lch(50% 0 0)', 'hwb(0 0% 0%)', 'color(srgb 1 0 0)',
];
const PALETTE_BAD = [
  'bg-slate-100', 'text-gray-500', 'border-zinc-200', 'ring-neutral-300', 'outline-stone-400', 'fill-red-500',
  'stroke-orange-600', 'shadow-amber-700', 'from-yellow-800', 'to-lime-900', 'via-green-50', 'decoration-emerald-100',
  'divide-teal-200', 'accent-cyan-300', 'caret-sky-400', 'bg-blue-500', 'bg-indigo-500', 'bg-violet-500', 'bg-purple-500',
  'bg-fuchsia-500', 'bg-pink-500', 'bg-rose-500', 'bg-black', 'text-white',
];
const TOGGLE_BAD = [
  ["document.documentElement.classList.toggle('dark')", 'writes the dark class'],
  ['root.classList.add("dark")', 'writes the dark class'],
  ["root.setAttribute('data-cc-theme', 'dark')", 'writes data-cc-theme'],
  ['<html className="dark">', 'sets the dark class'],
];

test('every theme rule still flags each of its known-bad samples, alternative by alternative', () => {
  const missed = [];
  let flagged = 0;
  for (const line of COLOUR_BAD) (colourHits(line).includes('literal colour') ? flagged++ : missed.push(`literal colour: ${line}`));
  for (const line of PALETTE_BAD) (colourHits(line).includes('palette utility') ? flagged++ : missed.push(`palette utility: ${line}`));
  for (const [code, what] of TOGGLE_BAD) {
    (TOGGLES.some((t) => t.what === what && t.re.test(code)) ? flagged++ : missed.push(`${what}: ${code}`));
  }
  assert.deepEqual(missed, []);
  assert.equal(flagged, COLOUR_BAD.length + PALETTE_BAD.length + TOGGLE_BAD.length);
  // And the clean shapes stay clean: token utilities and a `#` that is no colour.
  for (const ok of ['bg-card text-muted-foreground border-t-plan', "href=\"#\"", '#root']) assert.deepEqual(colourHits(ok), [], ok);
});

// A fixture tree breaking each rule from a script type other than .ts/.tsx, so a scan
// that stops reading .js, .jsx or .mjs fails here.
const FIXTURE = {
  'frontend/index.html': '<!doctype html>',
  'frontend/src/lib/palette.js': "export const red = '#ff0000';",
  'frontend/src/Tile.jsx': 'export const T = () => <p className="bg-red-500">x</p>;',
  'frontend/src/theme.mjs': "document.documentElement.classList.toggle('dark');",
  'frontend/src/Save.jsx': 'export const S = () => <Button>Save</Button>;',
  'frontend/src/Go.jsx': 'export const G = () => <><Button type="button">Go</Button><Button variant="destructive" type="button">Del</Button><Button variant="ghost" type="button">Ok</Button><button>raw</button></>;',
  'frontend/src/components/ui/button.tsx': "export const ink = '#000000';",
};

test('the theme guards read every script type the bundle can contain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kanban-theme-'));
  try {
    for (const [rel, text] of Object.entries(FIXTURE)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    assert.deepEqual(colourOffences(root).out, ['frontend/src/Tile.jsx:1: palette utility', 'frontend/src/lib/palette.js:1: literal colour']);
    assert.deepEqual(toggleOffences(root), ['frontend/src/theme.mjs: writes the dark class']);
    assert.deepEqual(buttonOffences(root).out, [
      'frontend/src/Go.jsx: a default-variant Button is the form\'s commit, so type="submit"',
      'frontend/src/Go.jsx: a destructive-variant Button is the form\'s commit, so type="submit"',
      'frontend/src/Go.jsx: <button> has no explicit type',
      'frontend/src/Save.jsx: <Button> has no explicit type',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
