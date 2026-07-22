import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoutes } from './src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.join(__dirname, 'frontend');

export function createServer() {
  const app = express();
  // API first so /api/* is never shadowed by the static frontend.
  app.use('/api', buildRoutes());
  // Serve the web GUI (zero-build vanilla ESM) at the manifest's frontend.path
  // ("/"). express.static serves index.html for the directory root.
  app.use(express.static(frontendDir));
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
