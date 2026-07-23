import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ordered board states (also the on-disk column dir names). The lifecycle in
// board.js constrains which transitions between these are legal.
export const STATES = ['triage', 'backlog', 'todo', 'in-progress', 'done'];

// Default projects root = parent dir of the code-kanban repo, resolved once.
// Layout: <parent>/code-kanban/src/paths.js -> <parent>/. The conductor injects
// the authoritative value as PROJECTS_ROOT when it spawns this plugin, so that
// env var always wins in a supervised run. Never hardcode the absolute path.
const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..',
);

export function projectsRoot() {
  return process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
}

// Board DATA lives in the conductor's tree under the hidden ".conduct" project,
// NOT in this repo. The constant ".conduct" is stable in the host
// (CONDUCT_PROJECT_NAME) and has no env override; the host rewrites
// .conduct/CONDUCT.md + CLAUDE.md on boot but never touches subdirs, so
// .conduct/kanban/ is safe.
export function kanbanRoot() {
  return path.join(projectsRoot(), '.conduct', 'kanban');
}

// A project's own git checkout — a sibling of this plugin under PROJECTS_ROOT,
// distinct from projectDir() (the board's .conduct/kanban DATA path above).
export function repoDir(project) {
  return path.join(projectsRoot(), project);
}

export function projectDir(project) {
  return path.join(kanbanRoot(), 'projects', project);
}

export function stateDir(project, state) {
  return path.join(projectDir(project), state);
}

export function epicsDir(project) {
  return path.join(projectDir(project), 'epics');
}

// Cross-project epics live ABOVE the per-project layout: one <slug>.md per epic,
// each naming its member projects in frontmatter. A per-project epic and a
// cross-project epic never share a slug in the same project (board.js guards it).
export function crossEpicsDir() {
  return path.join(kanbanRoot(), 'epics');
}
