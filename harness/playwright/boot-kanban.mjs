// Thin project-local wrapper over the shared code-playwright harness. Reuses its
// bootServer primitive (chromium discovery / launch / free-port / cleanup all
// live there) to launch code-kanban's server for visual verification.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer } from '../../../code-playwright/browser.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Boots server.js on a free ephemeral port. Pass a `sandbox` to isolate the
// board's on-disk state, e.g.:
//   bootKanban({ sandbox: { dirs: { PROJECTS_ROOT: 'root' } } })
// The child honours process.env.PORT (bootServer injects it) and PROJECTS_ROOT.
// The UI is the built frontend/dist, so a checkout without it fails here, not as
// a page of 503s.
export function bootKanban(opts = {}) {
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'frontend', 'dist', 'index.html'))) {
    throw new Error('frontend/dist not built — run npm install');
  }
  return bootServer({ cwd: PROJECT_ROOT, entry: 'server.js', ...opts });
}
