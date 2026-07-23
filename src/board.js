// The board service layer — the SINGLE SOURCE OF TRUTH for all board logic:
// transitions, id assignment, validation, log stamping, and refusal codes. It is
// consumed by the MCP tool surface (src/mcp.js) today and is the documented
// integration seam for the future web GUI (which runs in THIS process and
// imports board.js directly — see .wiki/architecture/service-layer-seam.md).
//
// Contract: every function is async and RETURNS a result object — {ok:true,...}
// on success, {ok:false, code, reason} on a domain refusal. It never throws for
// a domain outcome (unexpected exceptions are the caller's to catch). Every
// mutator runs inside withLock(project, ...) so writes serialize on one path.

import { STATES } from './paths.js';
import { validateProject } from './projects.js';
import { withLock } from './mutex.js';
import * as store from './store.js';
import { logLine } from './taskfile.js';

function fail(code, reason) { return { ok: false, code, reason }; }
function nowIso() { return new Date().toISOString(); }

// Legal state transitions. The forward path is the intended lifecycle; the extra
// entries are corrective moves the conductor (the sole trusted mutator) may need.
// triage is an inbox: its only exits are backlog OR todo (both first-class).
// Exported read-only so the in-process web GUI can render legal move targets
// from the single source of truth (no logic change — see docs/architecture.md).
export const ALLOWED_TRANSITIONS = new Set([
  'triage>backlog', 'triage>todo',   // intake -> queue (both first-class)
  'backlog>todo',                    // promotion
  'todo>in-progress',                // pick up
  'in-progress>done',                // land
  'todo>backlog',                    // demote
  'in-progress>todo',                // abandon
  'done>in-progress',                // reopen
]);

async function requireProject(project) {
  return (await validateProject(project))
    ? null
    : fail('PROJECT_UNKNOWN', `unknown project: ${project}`);
}

function summary(t) {
  return {
    id: t.id, title: t.title, state: t.state, project: t.project, epic: t.epic ?? null,
    priority: t.priority, owner: t.owner ?? null, depends_on: t.depends_on,
    created: t.created,
  };
}

// Stable ordering: by column, then priority asc, then id.
function sortTasks(tasks) {
  return tasks.sort((a, b) =>
    STATES.indexOf(a.state) - STATES.indexOf(b.state)
    || a.priority - b.priority
    || a.id.localeCompare(b.id));
}

// ---- worker + conductor ----

export async function fileTask({ project, title, goal, acceptance, epic, depends_on, sessionId } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (typeof title !== 'string' || !title.trim()) {
    return fail('INVALID_STATE', 'title is required and must be a non-empty string');
  }
  return withLock(project, () => {
    store.ensureProjectDirs(project);
    if (epic && !epicVisibleIn(project, epic)) {
      return fail('EPIC_UNKNOWN', `unknown epic: ${epic} (create it first with create_epic)`);
    }
    const id = store.nextId(project);
    const created = nowIso();
    const task = {
      id, title: title.trim(), project, epic: epic ?? null, priority: 0, created,
      owner: null, depends_on: Array.isArray(depends_on) ? depends_on : [],
      goal: typeof goal === 'string' ? goal : '',
      acceptance: (Array.isArray(acceptance) ? acceptance : []).map((text) => ({ text, done: false })),
      logbook: [logLine(created, sessionId, 'filed')],
    };
    store.writeTask(project, 'triage', task);
    return { ok: true, id };
  });
}

// Resolves the target card server-side from the caller's session: the in-progress
// card in this project owned by sessionId. Workers never handle a task id.
// If a session owns MORE THAN ONE in-progress card, resolve to the most recently
// modified one (see .wiki/gotchas/owner-from-caller-sessionid.md).
export async function logProgress({ project, entry, sessionId } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (typeof entry !== 'string' || !entry.trim()) {
    return fail('INVALID_STATE', 'entry is required and must be a non-empty string');
  }
  if (!sessionId) {
    return fail('TASK_UNKNOWN', 'no session id — cannot resolve an owned in-progress card');
  }
  return withLock(project, () => {
    const owned = store.listTasks(project, { state: 'in-progress' })
      .filter((t) => t.owner === sessionId)
      .sort((a, b) => b._mtimeMs - a._mtimeMs);
    if (owned.length === 0) {
      return fail('TASK_UNKNOWN', 'no in-progress card owned by this session');
    }
    const task = owned[0];
    task.logbook.push(logLine(nowIso(), sessionId, entry.trim()));
    store.writeTask(project, 'in-progress', task);
    return { ok: true };
  });
}

// ---- conductor: reads ----

export async function listTasks({ project, state, epic } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (state && !STATES.includes(state)) return fail('INVALID_STATE', `unknown state: ${state}`);
  let tasks = store.listTasks(project, { state });
  if (epic) tasks = tasks.filter((t) => t.epic === epic);
  return { ok: true, tasks: sortTasks(tasks).map(summary) };
}

export async function readTask({ project, id, logTail } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  const task = store.readTaskById(project, id);
  if (!task) return fail('TASK_UNKNOWN', `unknown task: ${id}`);
  if (Number.isFinite(logTail) && logTail >= 0) {
    // slice(-0) === slice(0) returns everything, so compute the start index
    // explicitly — logTail:0 must yield 0 entries (matches read_progress limit:0).
    task.logbook = task.logbook.slice(Math.max(0, task.logbook.length - logTail));
  }
  delete task._mtimeMs;
  return { ok: true, task };
}

export async function readProgress({ project, id, limit } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  const task = store.readTaskById(project, id);
  if (!task) return fail('TASK_UNKNOWN', `unknown task: ${id}`);
  const recent = [...task.logbook].reverse(); // most-recent first
  const entries = Number.isFinite(limit) && limit >= 0 ? recent.slice(0, limit) : recent;
  return { ok: true, entries, total: task.logbook.length };
}

// ---- conductor: mutations ----

export async function moveTask({ project, id, to, owner } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (!STATES.includes(to)) return fail('INVALID_STATE', `unknown target state: ${to}`);
  return withLock(project, () => {
    const task = store.readTaskById(project, id);
    if (!task) return fail('TASK_UNKNOWN', `unknown task: ${id}`);
    const from = task.state;
    if (from === to) return fail('INVALID_STATE', `already in ${to}`);
    if (!ALLOWED_TRANSITIONS.has(`${from}>${to}`)) {
      return fail('INVALID_STATE', `illegal transition ${from} -> ${to}`);
    }
    // owner is set only while in-progress.
    task.owner = to === 'in-progress' ? (owner ?? null) : null;
    task.logbook.push(logLine(nowIso(), owner, `moved ${from} -> ${to}`));
    store.moveTask(project, id, from, to, task);
    return { ok: true, from, to };
  });
}

const UPDATABLE = ['title', 'goal', 'epic', 'priority', 'depends_on'];

export async function updateTask({ project, id, fields } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (!fields || typeof fields !== 'object') return fail('INVALID_STATE', 'fields object is required');
  return withLock(project, () => {
    const task = store.readTaskById(project, id);
    if (!task) return fail('TASK_UNKNOWN', `unknown task: ${id}`);
    if (fields.epic && !epicVisibleIn(project, fields.epic)) {
      return fail('EPIC_UNKNOWN', `unknown epic: ${fields.epic}`);
    }
    for (const key of UPDATABLE) {
      if (!(key in fields)) continue;
      if (key === 'depends_on') task.depends_on = Array.isArray(fields.depends_on) ? fields.depends_on : [];
      else if (key === 'priority') task.priority = Number.parseInt(fields.priority, 10) || 0;
      else task[key] = fields[key];
    }
    store.writeTask(project, task.state, task);
    return { ok: true };
  });
}

// ---- epics ----
//
// An epic is EITHER project-scoped (a <project>/epics/<slug>.md record) OR
// cross-project (a top-level epics/<slug>.md record naming ≥2 member projects).
// Tasks join either kind via the same `epic: <slug>` field. A slug is never both
// at once for a given project: createEpic refuses the collision (EPIC_CONFLICT),
// so a task's epic slug resolves unambiguously — to the cross-project epic if one
// covers the task's project, else the project's own per-project epic.

const SLUG_RE = /^[a-z0-9._-]+$/;

// Sole lock key for the top-level cross-project store. Distinct from every
// project name (those match projects.NAME_RE, which forbids a leading space), so
// cross-epic writes serialize among themselves without touching a project mutex —
// the per-project single-writer invariant is preserved.
const CROSS_LOCK = ' cross-epics';

// Does slug `slug` name an epic visible to tasks in `project`? True if the
// project has its own epic file, OR a cross-project epic covering the project.
function epicVisibleIn(project, slug) {
  if (store.epicExists(project, slug)) return true;
  const x = store.readCrossEpic(slug);
  return !!x && x.projects.includes(project);
}

export async function createEpic({ project, projects, slug, title, goal } = {}) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return fail('INVALID_STATE', 'slug must match ^[a-z0-9._-]+$');
  }
  if (typeof title !== 'string' || !title.trim()) {
    return fail('INVALID_STATE', 'title is required');
  }
  const isCross = projects !== undefined;
  if (isCross === (project !== undefined)) {
    return fail('INVALID_STATE', 'give exactly one of project (project-scoped) or projects (cross-project)');
  }
  return isCross
    ? createCrossEpic({ projects, slug, title, goal })
    : createProjectEpic({ project, slug, title, goal });
}

async function createProjectEpic({ project, slug, title, goal }) {
  const bad = await requireProject(project);
  if (bad) return bad;
  return withLock(project, () => {
    // Guard: a cross-project epic covering this project owns the slug.
    const x = store.readCrossEpic(slug);
    if (x && x.projects.includes(project)) {
      return fail('EPIC_CONFLICT', `slug ${slug} is a cross-project epic covering ${project}`);
    }
    store.ensureProjectDirs(project);
    // Upsert: create, or refresh title/goal of an existing epic (idempotent).
    const existing = store.readEpic(project, slug);
    store.writeEpic(project, {
      slug, title: title.trim(), goal: goal ?? '',
      created: existing?.created ?? nowIso(),
    });
    return { ok: true };
  });
}

async function createCrossEpic({ projects, slug, title, goal }) {
  if (!Array.isArray(projects)) return fail('INVALID_STATE', 'projects must be an array');
  const members = [...new Set(projects)];
  if (members.length < 2) {
    return fail('INVALID_STATE', 'a cross-project epic must span at least 2 projects');
  }
  for (const p of members) {
    if (!(await validateProject(p))) return fail('PROJECT_UNKNOWN', `unknown project: ${p}`);
  }
  return withLock(CROSS_LOCK, () => {
    // Guard: any member already owns this slug as a per-project epic.
    const clash = members.find((p) => store.epicExists(p, slug));
    if (clash) {
      return fail('EPIC_CONFLICT', `slug ${slug} is a per-project epic in ${clash}`);
    }
    const existing = store.readCrossEpic(slug);
    store.writeCrossEpic({
      slug, title: title.trim(), goal: goal ?? '', projects: members,
      created: existing?.created ?? nowIso(),
    });
    return { ok: true };
  });
}

// Per-state counts for a project-scoped epic (one project's tasks).
function rollup(project, slug) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const t of store.listTasks(project)) {
    if (t.epic === slug) counts[t.state] += 1;
  }
  return counts;
}

// Per-state counts for a cross-project epic, aggregated across all members.
function crossRollup(slug, members) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const p of members) {
    for (const t of store.listTasks(p)) {
      if (t.epic === slug) counts[t.state] += 1;
    }
  }
  return counts;
}

export async function listEpics({ project } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  const epics = store.listEpicSlugs(project).map((slug) => {
    const e = store.readEpic(project, slug);
    return { slug, title: e?.title ?? '', rollup: rollup(project, slug), projects: null };
  });
  // Cross-project epics that span this project, with rollups over ALL members.
  for (const slug of store.listCrossEpicSlugs()) {
    const x = store.readCrossEpic(slug);
    if (x && x.projects.includes(project)) {
      epics.push({ slug, title: x.title, rollup: crossRollup(slug, x.projects), projects: x.projects });
    }
  }
  return { ok: true, epics };
}

export async function readEpic({ project, slug } = {}) {
  if (project !== undefined) {
    const bad = await requireProject(project);
    if (bad) return bad;
    // Project-scoped epic wins (the conflict guard makes this unambiguous).
    const e = store.readEpic(project, slug);
    if (e) {
      const tasks = sortTasks(store.listTasks(project).filter((t) => t.epic === slug)).map(summary);
      return { ok: true, epic: { slug, title: e.title, goal: e.goal, rollup: rollup(project, slug) }, tasks };
    }
  }
  // Cross-project epic (by slug; also the fall-through when project is a member).
  const x = store.readCrossEpic(slug);
  if (!x) return fail('EPIC_UNKNOWN', `unknown epic: ${slug}`);
  const tasks = sortTasks(
    x.projects.flatMap((p) => store.listTasks(p).filter((t) => t.epic === slug)),
  ).map(summary);
  return {
    ok: true,
    epic: { slug, title: x.title, goal: x.goal, rollup: crossRollup(slug, x.projects), projects: x.projects },
    tasks,
  };
}
