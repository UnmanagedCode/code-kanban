import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoutes } from './src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Sent on every response, API, 404, 503 and error responses included. style-src
// allows 'unsafe-inline' only because the Radix Dialog's scroll lock injects a
// <style> element; the UI never puts content into a style attribute or element.
// font-src carries the host theme's Geist fonts, script-src the host bridge.
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";

const sendText = (res, status, text) => res.status(status).type('text/plain').send(text);
// An /api path the router did not answer is an unknown route (404), built or not.
const isApiPath = (p) => p === '/api' || p.startsWith('/api/');
// express.static decodes the path before it looks the file up (`app.js%2Emap` is
// `app.js.map`), so the source-map guard judges the decoded form, case-insensitively.
// A malformed escape cannot be decoded, so it is left to static, which falls through
// (its status is below 500) to the terminal 404.
function isSourceMap(p) {
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { return false; }
  return decoded.toLowerCase().endsWith('.map');
}

// `distDir` is injectable so tests can serve a fixture build.
export function createServer({ distDir = path.join(__dirname, 'frontend', 'dist') } = {}) {
  const app = express();
  app.use((req, res, next) => {
    res.set({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  // API first so /api/* is never shadowed by a static file.
  app.use('/api', buildRoutes());
  app.use((req, res, next) => (isSourceMap(req.path) ? sendText(res, 404, 'Not found') : next()));

  const distIndex = path.join(distDir, 'index.html');
  if (fs.existsSync(distIndex)) {
    app.use(express.static(distDir, { index: 'index.html' }));
  } else {
    // The plugin still starts unbuilt (a failed or skipped install hook): the API
    // and health stay up, and every UI request says how to fix it.
    console.error(`UI not built: ${distIndex} is missing — run npm install`);
    app.use((req, res, next) => (isApiPath(req.path) ? next() : sendText(res, 503, 'UI not built — run npm install')));
  }

  // No SPA fallback: an unknown path (the host URLs standalone included) is a 404.
  app.use((req, res) => sendText(res, 404, 'Not found'));
  // Express's own error page would replace the CSP with its own; this keeps it.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error(err);
    const status = err.status ?? err.statusCode ?? 500;
    sendText(res, status, status === 500 ? 'Internal error' : err.message);
  });
  return http.createServer(app);
}

// listen with retry-on-EADDRINUSE — mirrors code-hub/code-conductor: a
// just-restarted instance may find the old listening socket lingering briefly.
function listenWithRetry(server, port, host, { tries = 40, delayMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const onErr = (e) => {
        server.off('listening', onOk);
        if (e.code === 'EADDRINUSE' && left > 0) setTimeout(() => attempt(left - 1), delayMs);
        else reject(e);
      };
      const onOk = () => { server.off('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    };
    attempt(tries);
  });
}

export async function start({ port = Number(process.env.PORT) || 7100, host = process.env.HOST || '127.0.0.1' } = {}) {
  const server = createServer();
  await listenWithRetry(server, port, host);
  const addr = server.address();
  // eslint-disable-next-line no-console
  console.log(`code-kanban listening on http://${host}:${addr.port}`);
  return server;
}

// Direct-run guard: only auto-start when invoked as `node server.js` (so the
// module stays importable in tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
