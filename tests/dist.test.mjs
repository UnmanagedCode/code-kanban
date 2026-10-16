import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, CSP } from '../server.js';

// The REAL build, as `npm install` (its `prepare` script) leaves it. Skipped when
// frontend/dist is absent (a fresh checkout before install, a mutation-harness
// copy); a fresh clone plus `npm install` must run it, not skip it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'frontend', 'dist');
const built = fs.existsSync(path.join(DIST, 'index.html'));
const SKIP = built ? false : 'frontend/dist not built — run npm install';

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  return d.isDirectory() ? files(p) : [p];
});
const html = () => fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const ofType = (ext) => files(DIST).filter((f) => f.endsWith(ext));

test('dist/index.html loads the bridge first and blocking, then the theme sheet, theme-init.js, then the module', { skip: SKIP }, () => {
  const head = html().match(/<head>([\s\S]*?)<\/head>/)[1];
  const tags = [...head.matchAll(/<(script|link)\b[^>]*>/g)].map((m) => m[0]);
  assert.match(tags[0], /^<script src="\/pluginBridge\.js"\s*>$/);
  assert.doesNotMatch(tags[0], /\b(defer|async|type=)/);
  assert.match(tags[1], /^<link rel="stylesheet" href="\/pluginTheme\.css"/);
  assert.match(tags[2], /^<script src="theme-init\.js"/);
  assert.match(tags[3], /^<script type="module"[^>]* src="\.\/assets\/[\w-]+\.js"/);
});

test('dist/index.html has no inline script body and no style attribute', { skip: SKIP }, () => {
  const page = html();
  for (const m of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) assert.equal(m[1].trim(), '', `inline script: ${m[0]}`);
  assert.doesNotMatch(page, /\sstyle\s*=/);
  assert.doesNotMatch(page, /<style\b/);
});

test('every URL in dist/index.html is relative except the two host URLs', { skip: SKIP }, () => {
  const urls = [...html().matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 5, `found only ${urls.length} URLs`);
  for (const u of urls) {
    if (u === '/pluginBridge.js' || u === '/pluginTheme.css') continue;
    assert.doesNotMatch(u, /^(\/|[a-z][a-z0-9+.-]*:)/i, u);
  }
});

test('the built CSS has no absolute URL, comments aside', { skip: SKIP }, () => {
  const css = ofType('.css');
  assert.ok(css.length > 0, 'no built CSS');
  for (const f of css) {
    const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(text, /https?:\/\/|url\(\/\//, f);
  }
});

test('the built JS holds no root-relative API literal, and the build has no source maps', { skip: SKIP }, () => {
  const js = ofType('.js');
  assert.ok(js.length > 1, 'expected theme-init.js and the bundle');
  for (const f of js) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /["'`]\/api\//, f);
  assert.deepEqual(ofType('.map'), []);
});

test('the server serves the real build: / and every asset index.html references, with the CSP', { skip: SKIP }, async () => {
  const server = createServer({ distDir: DIST });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const refs = [...html().matchAll(/\b(?:src|href)="([^"/][^"]*)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 3, `index.html references ${refs.length} own assets`);
    for (const ref of ['', ...refs]) {
      const res = await fetch(new URL(ref, base));
      assert.equal(res.status, 200, ref || '/');
      assert.equal(res.headers.get('content-security-policy'), CSP, ref || '/');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', ref || '/');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
