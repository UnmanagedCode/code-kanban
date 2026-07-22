// Thin project-local wrapper over the shared code-playwright harness. Reuses its
// bootServer primitive (chromium discovery / launch / free-port / cleanup all
// live there) to launch code-kanban's server for visual verification. Aimed at
// the future web GUI's key screen; until the GUI exists it can drive the JSON
// API surface (e.g. /api/health).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer } from '../../../code-playwright/browser.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Boots server.js on a free ephemeral port. Pass a `sandbox` to isolate the
// board's on-disk state, e.g.:
//   bootKanban({ sandbox: { dirs: { PROJECTS_ROOT: 'root' } } })
// The child honours process.env.PORT (bootServer injects it) and PROJECTS_ROOT.
export function bootKanban(opts = {}) {
  return bootServer({ cwd: PROJECT_ROOT, entry: 'server.js', ...opts });
}
