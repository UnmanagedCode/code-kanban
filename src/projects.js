import fs from 'node:fs';
import path from 'node:path';
import { projectsRoot } from './paths.js';

// A project name must be a single path segment (matches the host's rule).
export const NAME_RE = /^[a-zA-Z0-9._-]+$/;

// Seam for tests: swap the live-project fetcher so validation never touches the
// network. Pass null to restore the default.
let fetchProjectsImpl = defaultFetchProjects;
export function _setProjectFetcher(fn) {
  fetchProjectsImpl = fn ?? defaultFetchProjects;
}

// The conductor injects CONDUCTOR_URL when it spawns this plugin. Ask it for the
// authoritative live project list. With no conductor context (standalone/dev),
// fall back to scanning PROJECTS_ROOT with the same dot-dir / worktree skip
// rules the host applies.
async function defaultFetchProjects() {
  const base = process.env.CONDUCTOR_URL;
  if (!base) return scanProjectsRoot();
  const res = await fetch(`${base}/api/projects`);
  if (!res.ok) throw new Error(`conductor /api/projects returned ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.projects ?? []);
  return list.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
}

const WORKTREE_RE = /_worktree_[0-9a-f]+$/;

function scanProjectsRoot() {
  const root = projectsRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('.') && !WORKTREE_RE.test(n));
}

// Shape-check first (cheap, no I/O), then confirm against the live list.
export async function validateProject(project) {
  if (typeof project !== 'string' || !NAME_RE.test(project)) return false;
  const names = await fetchProjectsImpl();
  return names.includes(project);
}
