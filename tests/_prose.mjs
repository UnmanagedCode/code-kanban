// The repo's prose layers, shared by the prose tests (docCitations, docFormat).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Prose layers that cite code. `harness/` is included deliberately: its mutation
// README quotes module paths and test titles, and a gate that skips a whole
// directory is not a gate.
export const PROSE_ROOTS = ['docs', '.wiki', 'conventions', 'harness', 'README.md', 'CONVENTIONS.md'];

/** Repo-relative paths of the markdown files under `rel`. */
export function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return rel.endsWith('.md') ? [rel] : [];
  return fs.readdirSync(abs).flatMap((n) => walk(path.join(rel, n)));
}

/** Every markdown file in the prose layers. */
export const proseFiles = () => PROSE_ROOTS.flatMap(walk);
