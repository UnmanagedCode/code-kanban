import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each root's sibling Claude config dir, so cleanup() can remove both.
const configDirs = new Map();

// Fresh isolated projects root per test. Setting PROJECTS_ROOT is enough: every
// path helper reads it at call time. No network, no shared globals.
// CLAUDE_CONFIG_DIR points at a SIBLING temp dir — outside the root, so a test can
// tell the Claude plans dir (`paths.claudePlansDir`) from PROJECTS_ROOT, and no test
// ever resolves the real ~/.claude. Its plans/ dir is not created here.
export async function freshRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-kanban-'));
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'code-kanban-claude-'));
  process.env.PROJECTS_ROOT = dir;
  process.env.CLAUDE_CONFIG_DIR = config;
  configDirs.set(dir, config);
  return dir;
}

export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  const config = configDirs.get(dir);
  if (config !== undefined) {
    await fs.rm(config, { recursive: true, force: true });
    configDirs.delete(dir);
  }
}
