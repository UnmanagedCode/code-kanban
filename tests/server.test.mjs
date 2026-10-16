import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshRoot, cleanup } from './_helpers.mjs';
import { _setProjectFetcher } from '../src/projects.js';
import { createServer, start, CSP } from '../server.js';

// How server.js serves the built UI and what every response carries, against a
// fixture build (no `npm install` needed). tests/dist.test.mjs checks the real build.

function fixtureDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-kanban-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>fixture</title>');
  fs.writeFileSync(path.join(dir, 'theme-init.js'), '// theme');
  fs.writeFileSync(path.join(dir, 'assets', 'app-AbC_1.js'), 'export {};');
  fs.writeFileSync(path.join(dir, 'assets', 'app-AbC_1.js.map'), '{}');
  return dir;
}

async function withServer(distDir, fn) {
  const root = await freshRoot();
  _setProjectFetcher(async () => ['demo']);
  const server = createServer({ distDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
    await cleanup(root);
  }
}

async function withFixture(fn) {
  const dist = fixtureDist();
  try { await withServer(dist, fn); } finally { fs.rmSync(dist, { recursive: true, force: true }); }
}

// console.error replaced for the duration of `fn`; returns what it was called with.
async function capturingErrors(fn) {
  const real = console.error;
  const calls = [];
  console.error = (...args) => { calls.push(args); };
  try { await fn(); } finally { console.error = real; }
  return calls;
}

function assertHeaders(res, what) {
  assert.equal(res.headers.get('content-security-policy'), CSP, `${what}: CSP`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${what}: nosniff`);
}

const isPlain = (res) => /^text\/plain\b/.test(res.headers.get('content-type') ?? '');

test('/ serves the built index.html, and a built asset is served', async () => {
  await withFixture(async (base) => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /^text\/html/);
    assert.match(await root.text(), /fixture/);
    const asset = await fetch(`${base}/assets/app-AbC_1.js`);
    assert.equal(asset.status, 200);
    assert.equal((await fetch(`${base}/theme-init.js`)).status, 200);
  });
});

test('a .map file is never served, even when the build holds one — however the name is escaped or cased', async () => {
  await withFixture(async (base) => {
    for (const p of ['/assets/app-AbC_1.js.map', '/assets/app-AbC_1.js%2Emap', '/assets/app-AbC_1.js%2emap', '/assets/app-AbC_1.js.MAP', '/assets/app-AbC_1.js%2EMaP', '/assets/app-AbC_1.js%2E%6Dap']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 404, p);
      assert.ok(isPlain(res), p);
      assert.equal(await res.text(), 'Not found', p);
    }
    // A malformed escape cannot be decoded, so the guard leaves it to static: a client
    // error, never the map and never a 500.
    const errors = await capturingErrors(async () => {
      const bad = await fetch(`${base}/assets/%E0%A4%A.map`);
      assert.ok(bad.status >= 400 && bad.status < 500, String(bad.status));
      assert.ok(isPlain(bad));
    });
    assert.ok(errors.length <= 1);
  });
});

test('the host URLs and unknown paths are plain-text 404s, never the HTML page', async () => {
  await withFixture(async (base) => {
    for (const p of ['/pluginBridge.js', '/pluginTheme.css', '/nope', '/nope/deeper', '/api/x']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 404, p);
      assert.ok(isPlain(res), `${p}: ${res.headers.get('content-type')}`);
      assert.equal(await res.text(), 'Not found', p);
    }
  });
});

test('every response carries the CSP and nosniff: pages, assets, 404s, API results and API errors', async () => {
  await withFixture(async (base) => {
    const cases = [
      ['/', {}],
      ['/assets/app-AbC_1.js', {}],
      ['/assets/app-AbC_1.js.map', {}],
      ['/pluginTheme.css', {}],
      ['/nope', {}],
      ['/api/health', {}],
      ['/api/x', {}],
      ['/api/board/ghost/cards', {}], // a 200 {ok:false} refusal
      ['/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }],
    ];
    for (const [p, init] of cases) assertHeaders(await fetch(base + p, init), p);

    const refusal = await fetch(`${base}/api/board/ghost/cards`);
    assert.equal(refusal.status, 200);
    assert.equal((await refusal.json()).ok, false);
  });
});

test('an error past the API router keeps its client status as plain text, with the headers', async () => {
  await withFixture(async (base) => {
    const errors = await capturingErrors(async () => {
      const badParam = await fetch(`${base}/api/board/%E0%A4%A/cards`);
      assert.equal(badParam.status, 400);
      assert.ok(isPlain(badParam));
      assertHeaders(badParam, 'malformed URL');

      const tooLarge = await fetch(`${base}/api/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(300 * 1024) }),
      });
      assert.equal(tooLarge.status, 413);
      assert.ok(isPlain(tooLarge));
      assertHeaders(tooLarge, 'payload too large');
    });
    assert.equal(errors.length, 2);
  });
});

test('without a build: the UI answers a plain-text 503 naming npm install, the API stays up, the missing entry is logged once', async () => {
  const missing = path.join(os.tmpdir(), `code-kanban-no-dist-${process.pid}-${Date.now()}`);
  const errors = await capturingErrors(() => withServer(missing, async (base) => {
    for (const p of ['/', '/theme-init.js', '/assets/app.js']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 503, p);
      assert.ok(isPlain(res), p);
      assert.match(await res.text(), /npm install/);
      assertHeaders(res, `503 ${p}`);
    }
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const unknownApi = await fetch(`${base}/api/x`);
    assert.equal(unknownApi.status, 404, 'an unknown API route is a 404, not the UI 503');
    assert.ok(isPlain(unknownApi));
  }));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), new RegExp(`${path.join(missing, 'index.html').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('start() binds loopback by default', async () => {
  const savedHost = process.env.HOST;
  delete process.env.HOST;
  const realLog = console.log;
  console.log = () => {};
  let server;
  try {
    await capturingErrors(async () => { server = await start({ port: 0 }); });
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    console.log = realLog;
    if (savedHost !== undefined) process.env.HOST = savedHost;
    if (server) await new Promise((r) => server.close(r));
  }
});

test('the CSP is exactly the policy the UI needs, directive by directive', () => {
  const directives = Object.fromEntries(CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  // Each directive's reason is its assertion message: the headers elsewhere are
  // compared with this constant, so this list is what pins the policy itself.
  const expected = [
    ['default-src', ["'none'"], 'deny anything not listed'],
    ['script-src', ["'self'"], "the bundle, theme-init.js and cc's /pluginBridge.js; no inline script, no eval"],
    ['style-src', ["'self'", "'unsafe-inline'"], "the CSS bundle and cc's /pluginTheme.css, plus 'unsafe-inline' because the Radix Dialog's scroll lock injects a <style> element (without it, opening a dialog logs a CSP violation)"],
    ['font-src', ["'self'"], "the Geist fonts cc's theme sheet serves"],
    ['connect-src', ["'self'"], 'the API, by relative URL'],
    ['frame-ancestors', ["'self'"], 'framed only by code-conductor on the same origin'],
    ['base-uri', ["'none'"], 'no <base> rewrite'],
    ['form-action', ["'self'"], 'forms never post off-origin'],
  ];
  for (const [name, sources, why] of expected) assert.deepEqual(directives[name], sources, `${name}: ${why}`);
  assert.deepEqual(Object.keys(directives).sort(), expected.map(([name]) => name).sort(), 'no directive beyond these');
});
