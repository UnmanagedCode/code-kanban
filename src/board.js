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
const ALLOWED_TRANSITIONS = new Set([
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
    id: t.id, title: t.title, state: t.state, epic: t.epic ?? null,
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
    if (epic && !store.epicExists(project, epic)) {
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
export async function appendLog({ project, entry, sessionId } = {}) {
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
    // explicitly — logTail:0 must yield 0 entries (matches readLog limit:0).
    task.logbook = task.logbook.slice(Math.max(0, task.logbook.length - logTail));
  }
  delete task._mtimeMs;
  return { ok: true, task };
}

export async function readLog({ project, id, limit } = {}) {
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
    if (fields.epic && !store.epicExists(project, fields.epic)) {
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

const SLUG_RE = /^[a-z0-9._-]+$/;

export async function createEpic({ project, slug, title, goal } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return fail('INVALID_STATE', 'slug must match ^[a-z0-9._-]+$');
  }
  if (typeof title !== 'string' || !title.trim()) {
    return fail('INVALID_STATE', 'title is required');
  }
  return withLock(project, () => {
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

function rollup(project, slug) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const t of store.listTasks(project)) {
    if (t.epic === slug) counts[t.state] += 1;
  }
  return counts;
}

export async function listEpics({ project } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  const epics = store.listEpicSlugs(project).map((slug) => {
    const e = store.readEpic(project, slug);
    return { slug, title: e?.title ?? '', rollup: rollup(project, slug) };
  });
  return { ok: true, epics };
}

export async function readEpic({ project, slug } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  const e = store.readEpic(project, slug);
  if (!e) return fail('EPIC_UNKNOWN', `unknown epic: ${slug}`);
  const tasks = sortTasks(store.listTasks(project).filter((t) => t.epic === slug)).map(summary);
  return {
    ok: true,
    epic: { slug, title: e.title, goal: e.goal, rollup: rollup(project, slug) },
    tasks,
  };
}
