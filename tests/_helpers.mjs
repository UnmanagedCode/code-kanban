import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh isolated projects root per test. Setting PROJECTS_ROOT is enough: every
// path helper reads it at call time. No network, no shared globals.
export async function freshRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-kanban-'));
  process.env.PROJECTS_ROOT = dir;
  return dir;
}

export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}
