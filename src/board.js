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

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { STATES, plansDir } from './paths.js';
import { resolvePlanLink, classifyPlanInput, planBaseDir, isContained } from './planLink.js';
import { validateProject, listProjects } from './projects.js';
import { withLock } from './mutex.js';
import * as store from './store.js';
import { logLine } from './taskfile.js';
import { PRIORITIES, isPriority, priorityRank } from './priority.js';
import { localNodeId, deriveUid } from './nodeId.js';
import { headSha } from './git.js';
import { ownerCwd } from './ownerWorktree.js';

function fail(code, reason) { return { ok: false, code, reason }; }
function nowIso() { return new Date().toISOString(); }

// The `uid`/`updated`/`node` version stamp is hidden from every MCP/GUI read.
// summary() (list_tasks / epics) already whitelists fields; readTask returns a
// full card, so it strips these before returning. /api/sync/export is the ONLY
// intentional exposure. Call this on any full card leaving a read path.
function stripHidden(task) {
  delete task.uid;
  delete task.node;
  return task;
}

// Bump the version stamp on any local mutation so the LWW merge can tell which
// side is newer. Load-bearing: an edit that doesn't move `updated` is invisible
// to sync. Leaves `uid` untouched (a legacy card without one is given a
// deterministic uid at the sync boundary, not here).
function touch(task) {
  task.updated = nowIso();
  task.node = localNodeId();
  return task;
}

// An explicit commit lands verbatim in frontmatter (taskfile.js's `commit:
// <value>` line), so a value with an embedded newline or internal whitespace
// could inject a spurious extra frontmatter line/key on write. Take only the
// first line, trimmed; reject it (fall back to auto-capture) if that line
// still contains whitespace — a real sha is a single clean token.
function sanitizeCommit(commit) {
  if (typeof commit !== 'string') return '';
  const firstLine = commit.split('\n')[0].trim();
  return /\s/.test(firstLine) ? '' : firstLine;
}

// ---- plan links ----
//
// A card's `plan` is a LINK to a plan file (grammar + containment in
// src/planLink.js); the body is never stored on the card and never carried
// through the conductor's context. Every refusal shape lives here.

// Hard cap on a plan body served by read_task's includePlan. Deliberately
// tighter than project_read's 256 KiB — plan prose lands in an agent's context.
// A constant, not a parameter: nothing needs to tune it.
const PLAN_MAX_BYTES = 65536;

// The absolute path of a resolved link IF it is a regular file that really sits
// inside its base dir, else null. The realpath re-check closes the symlink hole:
// plans/ is worker-writable, so a symlink out of it would otherwise be an
// arbitrary-file read once includePlan exists.
function safePlanFile(project, resolved) {
  try {
    if (!fs.statSync(resolved.path).isFile()) return null;
    const realBase = fs.realpathSync(planBaseDir(project, resolved.scheme));
    const real = fs.realpathSync(resolved.path);
    return isContained(realBase, real) ? real : null;
  } catch {
    return null;
  }
}

// Ingest: copy an absolute source INTO the board as this card's plan file and
// return the stored `board:<id>.md` link. Copy, never move — the source (a plan
// wake's ~/.claude/plans/<slug>.md, typically) is never touched or modified. An
// existing destination is overwritten: last write wins, no versioning, so
// re-attaching a revised plan simply replaces the board's copy.
// -> {link} | a fail('PLAN_UNKNOWN', …)
function ingestPlanFile(project, id, source) {
  let stat;
  try { stat = fs.statSync(source); } // follows symlinks
  catch (e) { return fail('PLAN_UNKNOWN', `cannot read plan file at ${source}: ${e.message}`); }
  if (!stat.isFile()) return fail('PLAN_UNKNOWN', `plan source is not a regular file: ${source}`);

  const dir = plansDir(project);
  const dest = path.join(dir, `${id}.md`);
  const link = `board:${id}.md`;
  // Self-copy guard — the only special case: re-attaching plans/<id>.md by
  // absolute path, or via a symlink to it, must be a no-op success. Compared by
  // REALPATH, not string, since only that catches the symlink form.
  //
  // Deliberately kept even though it is (measurably) unobservable here: with the
  // guard removed, fs.copyFileSync(dest, dest) does NOT damage the file — libuv
  // opens the destination O_WRONLY|O_CREAT with NO O_TRUNC, compares st_dev/
  // st_ino and returns success without writing (strace'd on Node v24.18.0). But
  // that short-circuit is a libuv INTERNAL: node's fs.copyFile docs promise only
  // that an existing destination is overwritten and say nothing about a source
  // and destination that are the same file. Betting a data-loss-critical path on
  // a third-party library's unspecified behaviour is worse than three explicit
  // lines — in the self-copy case the destination IS the only copy of the plan.
  // Consequence for coverage: no test can kill the removal of this guard on
  // Linux/libuv, so that mutant is a WAIVED expected survivor (owner's decision
  // — see .wiki/gotchas/plan-link-and-sync-gap.md and harness/mutation/README.md).
  try {
    if (fs.existsSync(dest) && fs.realpathSync(source) === fs.realpathSync(dest)) return { link };
  } catch { /* either side unresolvable -> not the same file; fall through */ }

  try {
    // store.ensureProjectDirs creates plans/, but updateTask never calls it —
    // a project dir predating that function has none.
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(source, dest);
  } catch (e) {
    return fail('PLAN_UNKNOWN', `could not copy plan file from ${source}: ${e.message}`);
  }
  return { link };
}

// The single set-time validator for a caller-supplied plan value, shared by
// update_task, file_task and the GUI's PATCH route. -> {link} | a fail().
// A pointer (`board:`/`repo:`/bare relative) is stat-validated and NOTHING is
// written; a bare absolute path is ingested (copied in). `id` names the
// destination, so the copy always lands on the card's own plan file.
function resolvePlanForSet(project, value, id) {
  const c = classifyPlanInput(project, value);
  if (c.error) return fail(c.error.code, c.error.reason);
  if (c.kind === 'ingest') return ingestPlanFile(project, id, c.source);
  if (!safePlanFile(project, c)) {
    return fail('PLAN_UNKNOWN', `no plan file at ${c.link} (resolved to ${c.path})`);
  }
  return { link: c.link };
}

// Bounded read of a plan body -> {body, truncated} | null (unreadable).
// All fs in this repo is sync; read at most PLAN_MAX_BYTES.
function readPlanBody(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, PLAN_MAX_BYTES);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { body: buf.subarray(0, off).toString('utf8'), truncated: size > PLAN_MAX_BYTES };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

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

// The owned in-progress card in one project, or null. Read-only (no lock) — same as
// every other read in this file (listTasks/readTask/etc).
function findOwnedInProgressCard(project, sessionId) {
  return store.listTasks(project, { state: 'in-progress' })
    .filter((t) => t.owner === sessionId)
    .sort((a, b) => b._mtimeMs - a._mtimeMs)[0] ?? null;
}

// Scans every project for the session's owned in-progress card when logProgress isn't
// given one, picking the most-recently-modified across all of them. Unlocked best-effort
// snapshot — the caller re-verifies under the winning project's lock before writing (see
// .wiki/gotchas/owner-from-caller-sessionid.md).
async function resolveOwningProject(sessionId) {
  let bestProject = null;
  let bestMtime = -Infinity;
  for (const project of await listProjects()) {
    const candidate = findOwnedInProgressCard(project, sessionId);
    if (candidate && candidate._mtimeMs > bestMtime) {
      bestProject = project;
      bestMtime = candidate._mtimeMs;
    }
  }
  return bestProject;
}

function summary(t) {
  return {
    id: t.id, title: t.title, state: t.state, project: t.project, epic: t.epic ?? null,
    priority: t.priority, owner: t.owner ?? null, depends_on: t.depends_on,
    created: t.created, plan: t.plan ?? null,
  };
}

// Stable ordering: by column, then priority (CRITICAL first, LOW last, unset
// after LOW), then id. priorityRank is index-into-PRIORITIES, so ascending =
// highest priority first, and unset ranks past the end — an unjudged card never
// outranks a judged one.
function sortTasks(tasks) {
  return tasks.sort((a, b) =>
    STATES.indexOf(a.state) - STATES.indexOf(b.state)
    || priorityRank(a.priority) - priorityRank(b.priority)
    || a.id.localeCompare(b.id));
}

// ---- worker + conductor ----

// file_task's only non-default landing lanes — mirrors triage's legal exits
// (ALLOWED_TRANSITIONS has triage>backlog, triage>todo) rather than a separate list.
const CATEGORIES = ['todo', 'backlog'];

export async function fileTask({ project, title, goal, acceptance, epic, depends_on, category, priority, plan, sessionId } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (typeof title !== 'string' || !title.trim()) {
    return fail('INVALID_STATE', 'title is required and must be a non-empty string');
  }
  if (category !== undefined && !CATEGORIES.includes(category)) {
    return fail('INVALID_STATE', `category must be one of ${CATEGORIES.join(', ')}`);
  }
  // Strict at the caller surface — the tolerant mapping is for cards read off
  // disk, never for a value an author can be told is wrong (see priority.js).
  // Omitted and explicit null both mean unset: the card is simply unjudged, and
  // nothing here invents a level for it.
  if (priority != null && !isPriority(priority)) {
    return fail('INVALID_STATE', `priority must be one of ${PRIORITIES.join(', ')}, or null for unset`);
  }
  // Grammar-only pre-check, alongside the other cheap refusals: a malformed plan
  // value consumes nothing. The value is RESOLVED (stat/copy) inside the lock,
  // where the card's own id exists to name an ingest's destination.
  if (plan != null) {
    const c = classifyPlanInput(project, plan);
    if (c.error) return fail(c.error.code, c.error.reason);
  }
  return withLock(project, () => {
    store.ensureProjectDirs(project);
    if (epic && !epicVisibleIn(project, epic)) {
      return fail('EPIC_UNKNOWN', `unknown epic: ${epic} (create it first with create_epic)`);
    }
    const id = store.nextId(project);
    // Copy-then-write: a refused plan returns BEFORE store.writeTask, so no card
    // is created and no id is burned (the floor is bumped by writeTask, not
    // nextId — so the next file_task gets this same id).
    let planLink = null;
    if (plan != null) {
      const resolved = resolvePlanForSet(project, plan, id);
      if (resolved.ok === false) return resolved;
      planLink = resolved.link;
    }
    const created = nowIso();
    const task = {
      id, uid: crypto.randomUUID(), title: title.trim(), project, epic: epic ?? null,
      priority: priority ?? null, created, updated: created, node: localNodeId(),
      owner: null, plan: planLink, depends_on: Array.isArray(depends_on) ? depends_on : [],
      goal: typeof goal === 'string' ? goal : '',
      acceptance: (Array.isArray(acceptance) ? acceptance : []).map((text) => ({ text, done: false })),
      logbook: [logLine(created, sessionId, 'filed')],
    };
    store.writeTask(project, category ?? 'triage', task);
    // Report the resolved link only when `plan` was part of the call, so no
    // existing response shape changes.
    return plan != null ? { ok: true, id, plan: planLink } : { ok: true, id };
  });
}

// Permanent removal — no undo, no logbook (the file is gone). Not sync-aware:
// see docs/architecture.md's grow-only note and delete_task's tool description.
export async function deleteTask({ project, id } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  return withLock(project, () => {
    // Read the card BEFORE deleting so the plan link is still available; the
    // card file is the authoritative op and goes first.
    const task = store.readTaskById(project, id);
    if (!store.deleteTask(project, id)) return fail('TASK_UNKNOWN', `unknown task: ${id}`);
    // Best-effort: a board: plan file belongs to the card, so it goes too. A
    // repo: plan is a source-tree file and is NEVER touched. A failed unlink
    // leaves a harmless orphan and must not fail the delete.
    if (task?.plan) {
      const resolved = resolvePlanLink(project, task.plan);
      if (!resolved.error && resolved.scheme === 'board') {
        try { fs.rmSync(resolved.path, { force: true }); } catch { /* orphan, not a failure */ }
      }
    }
    return { ok: true };
  });
}

// Two resolution paths, chosen by whether `id` is given:
// - `id` given (conductor path): targets that exact card directly, BYPASSING the
//   owner check — the conductor owns no card. `project` is required alongside `id`
//   (ids are per-project, not globally unique). The card must be `in-progress` or
//   this returns TASK_UNKNOWN. Logged with conductor attribution (logLine's
//   sessionId ?? 'conductor' convention — see taskfile.js), matching how moveTask
//   attributes its own logbook lines.
// - `id` omitted (worker path, unchanged): resolves the in-progress card owned by
//   sessionId server-side. Workers never handle a task id. `project`, if given,
//   scopes the lookup directly (fast path); if omitted, every project is scanned for
//   the owned card. If a session owns MORE THAN ONE in-progress card, resolve to the
//   most recently modified one, across projects when scanning.
// (see .wiki/gotchas/owner-from-caller-sessionid.md)
export async function logProgress({ project, id, entry, sessionId } = {}) {
  if (id !== undefined) {
    if (project === undefined) {
      return fail('INVALID_STATE', 'project is required when id is given (ids are per-project)');
    }
    const bad = await requireProject(project);
    if (bad) return bad;
    if (typeof entry !== 'string' || !entry.trim()) {
      return fail('INVALID_STATE', 'entry is required and must be a non-empty string');
    }
    return withLock(project, () => {
      const task = store.readTaskById(project, id);
      if (!task || task.state !== 'in-progress') {
        return fail('TASK_UNKNOWN', `no in-progress card: ${id}`);
      }
      task.logbook.push(logLine(nowIso(), null, entry.trim()));
      store.writeTask(project, 'in-progress', touch(task));
      return { ok: true };
    });
  }

  if (project !== undefined) {
    const bad = await requireProject(project);
    if (bad) return bad;
  }
  if (typeof entry !== 'string' || !entry.trim()) {
    return fail('INVALID_STATE', 'entry is required and must be a non-empty string');
  }
  if (!sessionId) {
    return fail('TASK_UNKNOWN', 'no session id — cannot resolve an owned in-progress card');
  }
  const targetProject = project !== undefined ? project : await resolveOwningProject(sessionId);
  if (targetProject === null) {
    return fail('TASK_UNKNOWN', 'no in-progress card owned by this session');
  }
  return withLock(targetProject, () => {
    // Re-verify under the lock: if the card lost ownership or left in-progress
    // between the unlocked scan above and here, this returns TASK_UNKNOWN rather
    // than falling back to re-scan other projects (untested — see
    // .wiki/gotchas/owner-from-caller-sessionid.md).
    const task = findOwnedInProgressCard(targetProject, sessionId);
    if (!task) {
      return fail('TASK_UNKNOWN', 'no in-progress card owned by this session');
    }
    task.logbook.push(logLine(nowIso(), sessionId, entry.trim()));
    store.writeTask(targetProject, 'in-progress', touch(task));
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

// Envelope: {ok, task, plan_path, plan_body?, plan_truncated?, plan_missing?}.
// The plan fields sit TOP-LEVEL (never inside `task`, which mirrors frontmatter
// 1:1). `plan_path` is returned always — null when there is no link or the
// stored link is ungrammatical (e.g. arrived by sync from a newer peer). A plan
// file that is missing/unreadable is NEVER a refusal: plan_body:null +
// plan_missing:true. plan_missing is false when the card simply has no link.
export async function readTask({ project, id, logTail, includePlan } = {}) {
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
  const resolved = task.plan ? resolvePlanLink(project, task.plan) : null;
  const ok = resolved && !resolved.error ? resolved : null;
  const out = { ok: true, task: stripHidden(task), plan_path: ok ? ok.path : null };
  if (includePlan) {
    const file = ok ? safePlanFile(project, ok) : null;
    const read = file ? readPlanBody(file) : null;
    out.plan_body = read ? read.body : null;
    out.plan_truncated = read ? read.truncated : false;
    out.plan_missing = task.plan ? read === null : false;
  }
  return out;
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

export async function moveTask({ project, id, to, owner, commit } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (!STATES.includes(to)) return fail('INVALID_STATE', `unknown target state: ${to}`);
  return withLock(project, async () => {
    const task = store.readTaskById(project, id);
    if (!task) return fail('TASK_UNKNOWN', `unknown task: ${id}`);
    const from = task.state;
    if (from === to) return fail('INVALID_STATE', `already in ${to}`);
    if (!ALLOWED_TRANSITIONS.has(`${from}>${to}`)) {
      return fail('INVALID_STATE', `illegal transition ${from} -> ${to}`);
    }
    // Capture before the clear below — landing needs the PRIOR (in-progress)
    // owner to know whose worktree to read.
    const priorOwner = task.owner;
    // owner is set only while in-progress.
    task.owner = to === 'in-progress' ? (owner ?? null) : null;
    // Landing (only reachable from in-progress): stamp the merge/commit sha.
    // An explicit commit wins (the caller may know a squash-merge sha that
    // differs from the current branch HEAD at call time); otherwise resolve
    // the prior owner's live working directory (a worktree cwd, typically —
    // see ownerWorktree.js) and read ITS HEAD. The base project checkout's
    // own HEAD is deliberately never used: a worker's commits live on its
    // worktree branch and are absent from the base checkout until a merge.
    // Never refuse the move if neither the explicit value nor the owner's
    // worktree resolves.
    if (to === 'done') {
      const explicit = sanitizeCommit(commit);
      let sha = explicit;
      if (!sha && priorOwner) {
        const cwd = await ownerCwd(priorOwner);
        if (cwd) sha = await headSha(cwd);
      }
      if (sha) task.commit = sha;
    }
    task.logbook.push(logLine(nowIso(), owner, `moved ${from} -> ${to}`));
    store.moveTask(project, id, from, to, touch(task));
    return { ok: true, from, to };
  });
}

const UPDATABLE = ['title', 'goal', 'epic', 'priority', 'depends_on', 'plan', 'owner'];

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
    // null clears the level back to unset (and round-trips: serialize then drops
    // the frontmatter key entirely). Anything else non-canonical is a caller bug.
    if ('priority' in fields && fields.priority !== null && !isPriority(fields.priority)) {
      return fail('INVALID_STATE', `priority must be one of ${PRIORITIES.join(', ')}, or null for unset`);
    }
    // plan/owner are validated up here, alongside the epic check. What actually
    // guarantees no half-applied card is that every refusal returns before the
    // single store.writeTask at the end — `task` is an in-memory parse, so
    // nothing is PERSISTED on a refusal path regardless of this ordering.
    let planNext;
    if ('plan' in fields) {
      if (fields.plan === null) planNext = null;
      else {
        const resolved = resolvePlanForSet(project, fields.plan, id);
        if (resolved.ok === false) return resolved;
        planNext = resolved.link; // the NORMALISED link (a bare path gains board:, an absolute path is ingested)
      }
    }
    let ownerNext;
    if ('owner' in fields) {
      if (task.state !== 'in-progress') {
        return fail('INVALID_STATE', 'owner can only be set on an in-progress card');
      }
      if (fields.owner === null) ownerNext = null;
      else if (typeof fields.owner !== 'string' || fields.owner === '' || /\s/.test(fields.owner)) {
        // A session id is one clean token — same reasoning as sanitizeCommit
        // (the value lands verbatim on a one-line frontmatter key).
        return fail('INVALID_STATE', 'owner must be a non-empty session id with no whitespace');
      } else ownerNext = fields.owner;
    }
    for (const key of UPDATABLE) {
      if (!(key in fields) || key === 'plan' || key === 'owner') continue;
      if (key === 'depends_on') task.depends_on = Array.isArray(fields.depends_on) ? fields.depends_on : [];
      else task[key] = fields[key]; // priority is validated above, so it lands verbatim (incl. null)
    }
    if ('plan' in fields) task.plan = planNext;
    if ('owner' in fields) {
      const prev = task.owner ?? null;
      // Only a real change is logged (a no-op set stamps nothing) — the line is
      // the handoff audit trail, mirroring moveTask's `moved <from> -> <to>`.
      if (prev !== ownerNext) {
        task.owner = ownerNext;
        task.logbook.push(logLine(nowIso(), null, `owner ${prev ?? 'none'} -> ${ownerNext ?? 'none'}`));
      }
    }
    store.writeTask(project, task.state, touch(task));
    // Report the stored link (an ingest's destination is `board:<id>.md`, which
    // the caller would otherwise have to infer) only when `plan` was in the call.
    return 'plan' in fields ? { ok: true, plan: planNext } : { ok: true };
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
      updated: nowIso(), node: localNodeId(), // sync version stamp (see writeEpic)
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
      updated: nowIso(), node: localNodeId(), // sync version stamp (see writeEpic)
    });
    return { ok: true };
  });
}

// ---- cross-instance sync ----
//
// Two-click, one-way-pull-per-click. A pull fetches the peer's FULL board dump
// for a scope and merges by `uid` (union + whole-card last-edit-wins). Display
// ids (2026-NNNN) are per-project/per-machine, so an incoming card whose id
// collides with a DIFFERENT local uid is reassigned a free local id; depends_on
// (display-id sugar over uid) is translated remote-id -> uid -> local-id at the
// boundary, dropping entries that don't resolve from the pulled set. Every merge
// write goes through the same store + per-project withLock as any other mutator.
// See .wiki/architecture/cross-instance-sync.md.

// Network seam (mirrors projects._setProjectFetcher): tests inject a canned peer
// export instead of hitting a real instance.
const SYNC_FETCH_TIMEOUT_MS = 15_000;
const SYNC_MAX_BYTES = 25 * 1024 * 1024; // hard ceiling on a peer dump (~25 MB)
async function defaultSyncFetch(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error', // never chase a redirect off the vetted host (SSRF)
    signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS), // no unbounded hang
  });
  if (!res.ok) throw new Error(`peer export HTTP ${res.status}`);
  // Stream with a size cap so a huge (or content-length-lying) peer can't OOM
  // the handler.
  const reader = res.body?.getReader();
  if (!reader) return res.json();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > SYNC_MAX_BYTES) { await reader.cancel(); throw new Error('peer export exceeds size limit'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
}
let syncFetch = defaultSyncFetch;
export function _setSyncFetcher(fn) { syncFetch = fn ?? defaultSyncFetch; }

// Loopback / private / link-local ranges the pull must never fetch. net.BlockList
// handles v4 and v6 uniformly; IPv4-mapped IPv6 is normalised to its v4 below so
// e.g. ::ffff:127.0.0.1 is caught by the v4 rules.
const SYNC_BLOCKLIST = new net.BlockList();
SYNC_BLOCKLIST.addSubnet('0.0.0.0', 8, 'ipv4');      // unspecified / "this host"
SYNC_BLOCKLIST.addSubnet('127.0.0.0', 8, 'ipv4');    // loopback
SYNC_BLOCKLIST.addSubnet('10.0.0.0', 8, 'ipv4');     // private
SYNC_BLOCKLIST.addSubnet('172.16.0.0', 12, 'ipv4');  // private
SYNC_BLOCKLIST.addSubnet('192.168.0.0', 16, 'ipv4'); // private
SYNC_BLOCKLIST.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local incl. 169.254.169.254
SYNC_BLOCKLIST.addAddress('::1', 'ipv6');            // loopback
SYNC_BLOCKLIST.addAddress('::', 'ipv6');             // unspecified
SYNC_BLOCKLIST.addSubnet('fc00::', 7, 'ipv6');       // unique-local
SYNC_BLOCKLIST.addSubnet('fe80::', 10, 'ipv6');      // link-local

// Extract the embedded IPv4 of an IPv4-mapped IPv6 literal, in either the dotted
// (`::ffff:127.0.0.1`) or the hex form node's URL parser normalises to
// (`::ffff:7f00:1`). Returns null if `h` isn't a mapped address.
function mappedV4(h) {
  let m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (m) return m[1];
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (m) {
    const hi = Number.parseInt(m[1], 16); const lo = Number.parseInt(m[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

// SSRF guard: the pull fetches a user-supplied URL server-side, so refuse
// loopback / private / link-local IP LITERALS (incl. the cloud metadata IP
// 169.254.169.254 and its IPv4-mapped form). Kept lightweight — hostnames are
// NOT DNS-resolved (a code-hub-forwarded peer is a public host); set
// CODE_KANBAN_SYNC_ALLOW_PRIVATE=1 to allow private targets for local dev / the
// visual harness.
function isBlockedSyncHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); // strip v6 brackets + a trailing dot
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
  const fam = net.isIP(h);
  if (!fam) return false; // a hostname, not an IP literal — not resolved here
  if (fam === 6) {
    const v4 = mappedV4(h);
    if (v4 && SYNC_BLOCKLIST.check(v4, 'ipv4')) return true;
    return SYNC_BLOCKLIST.check(h, 'ipv6');
  }
  return SYNC_BLOCKLIST.check(h, 'ipv4');
}

// Backfill the hidden version stamp on a legacy card (one that predates sync).
// `uid` is DETERMINISTIC from (project,id,created) so two machines holding the
// same shared-lineage card derive the same uid and union instead of duplicating.
// Returns true if anything changed. In-memory only — callers persist.
function ensureIdentity(task, project) {
  let changed = false;
  if (!task.uid) { task.uid = deriveUid(project, task.id, task.created); changed = true; }
  if (!task.updated) { task.updated = task.created ?? nowIso(); changed = true; }
  if (!task.node) { task.node = localNodeId(); changed = true; }
  return changed;
}

// Read a project's full card set, persisting any backfilled identity so the dump
// is self-consistent. MUST run inside withLock(project, ...).
function backfillProject(project) {
  const cards = store.exportTasks(project);
  for (const c of cards) {
    if (ensureIdentity(c, project)) store.writeTask(project, c.state, c);
  }
  return cards;
}

// LWW: does the incoming card win over the local one? Later `updated` wins;
// on an exact tie the higher `node` id wins (deterministic on both machines,
// which each hold both node ids). Equal on both -> local stays (no-op).
function remoteWins(remote, local) {
  const ru = remote.updated ?? '';
  const lu = local.updated ?? '';
  if (ru !== lu) return ru > lu;
  return (remote.node ?? '') > (local.node ?? '');
}

// ---- epic sync ----
// Epics match by SLUG (not uid): the slug is human-chosen, addressable identity
// that cards reference via `epic:`, so it is never reassigned and card refs need
// no translation. Union by slug + whole-epic LWW (updated, tiebreak node). A
// legacy epic (no stamp) gets updated = created deterministically so shared
// slugs match; node is only the tiebreak.
function ensureEpicIdentity(epic) {
  let changed = false;
  if (!epic.updated) { epic.updated = epic.created ?? nowIso(); changed = true; }
  if (!epic.node) { epic.node = localNodeId(); changed = true; }
  return changed;
}

// Read + persist-backfill a project's epics. MUST run inside withLock(project).
function backfillProjectEpics(project) {
  const out = [];
  for (const slug of store.listEpicSlugs(project)) {
    const e = store.readEpic(project, slug);
    if (!e) continue;
    if (ensureEpicIdentity(e)) store.writeEpic(project, e);
    out.push(e);
  }
  return out;
}

// Read + persist-backfill all cross-project epics. MUST run inside withLock(CROSS_LOCK).
function backfillCrossEpics() {
  const out = [];
  for (const slug of store.listCrossEpicSlugs()) {
    const e = store.readCrossEpic(slug);
    if (!e) continue;
    if (ensureEpicIdentity(e)) store.writeCrossEpic(e);
    out.push(e);
  }
  return out;
}

// Merge incoming cross-project epics. MUST run inside withLock(CROSS_LOCK), and
// runs BEFORE the per-project card/epic merge. Kind conflict (a member already
// owns the slug as a per-project epic) -> skip + log, mirroring createEpic's
// EPIC_CONFLICT guard (no deletion). This phase also resolves an intra-dump
// kind flip deterministically: a slug that is cross here is written first, so the
// later project-epic merge for that slug hits the guard and is skipped+logged.
function mergeCrossEpics(remoteCross, localProjects, summary) {
  const localBySlug = new Map();
  for (const e of backfillCrossEpics()) localBySlug.set(e.slug, e);
  for (const re of remoteCross) {
    if (typeof re?.slug !== 'string' || !SLUG_RE.test(re.slug)) {
      summary.skippedEpics.push({ slug: (re && typeof re.slug === 'string') ? re.slug : null, kind: 'cross' });
      continue;
    }
    const members = Array.isArray(re.projects) ? [...new Set(re.projects)] : [];
    if (members.length < 2) { summary.skippedEpics.push({ slug: re.slug, kind: 'cross' }); continue; }
    if (!members.some((p) => localProjects.has(p))) continue; // covers no local project — irrelevant
    const clash = members.find((p) => store.epicExists(p, re.slug));
    if (clash) { summary.epicConflicts.push({ slug: re.slug, kind: 'cross-vs-project', project: clash }); continue; }
    ensureEpicIdentity(re);
    const local = localBySlug.get(re.slug);
    if (!local) { store.writeCrossEpic({ ...re, projects: members }); summary.epicsAdded += 1; }
    else if (remoteWins(re, local)) { store.writeCrossEpic({ ...re, projects: members }); summary.epicsUpdated += 1; }
  }
}

// Merge a project's incoming project-scoped epics. MUST run inside
// withLock(project), BEFORE cards. Kind conflict (slug is a local cross epic
// covering this project) -> skip + log.
function mergeProjectEpics(project, remoteEpics, summary) {
  const localBySlug = new Map();
  for (const e of backfillProjectEpics(project)) localBySlug.set(e.slug, e);
  for (const re of remoteEpics) {
    if (typeof re?.slug !== 'string' || !SLUG_RE.test(re.slug)) {
      summary.skippedEpics.push({ slug: (re && typeof re.slug === 'string') ? re.slug : null, kind: 'project' });
      continue;
    }
    const x = store.readCrossEpic(re.slug);
    if (x && x.projects.includes(project)) {
      summary.epicConflicts.push({ slug: re.slug, kind: 'project-vs-cross', project });
      continue;
    }
    ensureEpicIdentity(re);
    const local = localBySlug.get(re.slug);
    if (!local) { store.writeEpic(project, re); summary.epicsAdded += 1; }
    else if (remoteWins(re, local)) { store.writeEpic(project, re); summary.epicsUpdated += 1; }
  }
}

export async function exportBoard({ scope, project } = {}) {
  if (scope !== 'all' && scope !== 'project') {
    return fail('INVALID_STATE', "scope must be 'project' or 'all'");
  }
  let targets;
  if (scope === 'project') {
    const bad = await requireProject(project);
    if (bad) return bad;
    targets = [project];
  } else {
    targets = await listProjects();
  }
  const projects = {};
  const projectEpics = {};
  for (const p of targets) {
    const r = await withLock(p, () => ({ cards: backfillProject(p), epics: backfillProjectEpics(p) }));
    projects[p] = r.cards;
    projectEpics[p] = r.epics;
  }
  // Cross epics: for a single-project export, only those covering the project (=
  // exactly the cross epics a card in that project can reference); for all, every
  // cross epic. Under CROSS_LOCK, separate from the per-project locks.
  const crossEpics = await withLock(CROSS_LOCK, () => {
    const all = backfillCrossEpics();
    return scope === 'project' ? all.filter((e) => e.projects.includes(project)) : all;
  });
  return { ok: true, nodeId: localNodeId(), scope, projects, projectEpics, crossEpics };
}

export async function syncPull({ peerUrl, scope, project } = {}) {
  if (scope !== 'all' && scope !== 'project') {
    return fail('INVALID_STATE', "scope must be 'project' or 'all'");
  }
  let base;
  let host;
  try {
    const u = new URL(peerUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    host = u.hostname;
    base = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return fail('INVALID_STATE', 'peerUrl must be an absolute http(s) URL');
  }
  if (process.env.CODE_KANBAN_SYNC_ALLOW_PRIVATE !== '1' && isBlockedSyncHost(host)) {
    return fail('INVALID_STATE', 'peerUrl host is a loopback/private/link-local address (blocked)');
  }
  if (scope === 'project') {
    const bad = await requireProject(project);
    if (bad) return bad;
  }

  const url = `${base}/api/sync/export?scope=${scope}`
    + (scope === 'project' ? `&project=${encodeURIComponent(project)}` : '');
  let dump;
  try {
    dump = await syncFetch(url);
  } catch (e) {
    return fail('SYNC_UNREACHABLE', `could not pull from peer: ${e.message}`);
  }
  if (!dump || typeof dump.projects !== 'object' || dump.projects === null) {
    return fail('SYNC_UNREACHABLE', 'peer returned no board data');
  }

  const localProjects = new Set(await listProjects());
  // NB: this summary reaches the GUI (routes.js -> app.js), so it must carry NO
  // hidden uid/node — only display ids, slugs, project names, and counts. See
  // stripHidden's invariant.
  const summary = {
    added: 0, updated: 0, reassigned: [], droppedDeps: [], skippedProjects: [], skippedCards: [],
    epicsAdded: 0, epicsUpdated: 0, epicConflicts: [], skippedEpics: [], perProject: {},
  };

  // Epics merge BEFORE cards so a card's `epic:` resolves against fresh epics.
  // Cross-project epics first, under CROSS_LOCK (a peer with no epics — an older
  // card-only build — simply supplies empty sets).
  const remoteCross = Array.isArray(dump.crossEpics) ? dump.crossEpics : [];
  await withLock(CROSS_LOCK, () => mergeCrossEpics(remoteCross, localProjects, summary));
  const remoteProjectEpics = (dump.projectEpics && typeof dump.projectEpics === 'object') ? dump.projectEpics : {};

  const toMerge = scope === 'project' ? [project] : Object.keys(dump.projects);
  for (const p of toMerge) {
    const remoteCards = dump.projects[p];
    if (!Array.isArray(remoteCards)) continue;
    if (!localProjects.has(p)) { summary.skippedProjects.push(p); continue; }
    const epics = Array.isArray(remoteProjectEpics[p]) ? remoteProjectEpics[p] : [];
    const pr = await withLock(p, () => mergeProject(p, remoteCards, epics, summary));
    summary.perProject[p] = pr;
  }
  return { ok: true, summary };
}

// Merge one project's incoming project-epics then cards into the local board.
// MUST run inside withLock(project, ...). Epics first so a card's `epic:` (kept
// verbatim — slugs are stable, never translated) resolves against fresh epics.
function mergeProject(project, remoteCards, remoteEpics, summary) {
  store.ensureProjectDirs(project);
  mergeProjectEpics(project, remoteEpics, summary);
  const localCards = backfillProject(project);

  const localByUid = new Map();
  const usedIds = new Set();
  // Seed from the persisted floor (store.js's nextId uses the same one) so a
  // locally-deleted high-numbered card can't make this allocator reuse its id.
  let maxNum = store.idFloor(project);
  const idNum = (id) => { const m = /(\d+)\s*$/.exec(id ?? ''); return m ? Number.parseInt(m[1], 10) : 0; };
  for (const c of localCards) {
    localByUid.set(c.uid, c);
    usedIds.add(c.id);
    maxNum = Math.max(maxNum, idNum(c.id));
  }
  const year = new Date().getFullYear();
  const allocId = () => {
    let cand;
    do { cand = `${year}-${String(++maxNum).padStart(4, '0')}`; } while (usedIds.has(cand));
    usedIds.add(cand);
    return cand;
  };

  // Validate incoming shape before it can reach deriveUid/writeTask: a card
  // without a usable display id or a known column would write a garbage file.
  // Skip (and report) rather than corrupt the store.
  const valid = [];
  for (const rc of remoteCards) {
    if (!rc || typeof rc.id !== 'string' || !rc.id.trim() || !STATES.includes(rc.state)) {
      summary.skippedCards.push({ project, id: (rc && typeof rc.id === 'string') ? rc.id : null });
      continue;
    }
    valid.push(rc);
  }

  // Remote lookups (ensure remote identity in-memory in case a peer served a
  // card without a uid — deterministic derivation keeps matching stable).
  const remoteIdToUid = new Map();
  for (const rc of valid) {
    ensureIdentity(rc, project);
    remoteIdToUid.set(rc.id, rc.uid);
  }

  // uid -> final local display id, seeded with every local card so depends_on
  // that points at a local-only or LWW-losing card still resolves.
  const uidToLocalId = new Map();
  for (const c of localCards) uidToLocalId.set(c.uid, c.id);

  // Pass A: classify each incoming card and assign final local display ids.
  const replaces = []; // {rc, localId, fromState}
  const inserts = [];  // {rc, localId}
  const newUid = [];
  for (const rc of valid) {
    const local = localByUid.get(rc.uid);
    if (local) {
      if (remoteWins(rc, local)) replaces.push({ rc, localId: local.id, fromState: local.state });
      // uidToLocalId already maps this uid to local.id (kept either way).
    } else {
      newUid.push(rc);
    }
  }
  // Reserve free desired ids first (minimise churn), then reassign collisions.
  const pending = [];
  for (const rc of newUid) {
    if (usedIds.has(rc.id)) { pending.push(rc); continue; }
    usedIds.add(rc.id);
    uidToLocalId.set(rc.uid, rc.id);
    inserts.push({ rc, localId: rc.id });
  }
  for (const rc of pending) {
    const localId = allocId();
    uidToLocalId.set(rc.uid, localId);
    // Display ids only (from = peer's id, to = local id) — no uid in the summary.
    summary.reassigned.push({ project, from: rc.id, to: localId });
    inserts.push({ rc, localId });
  }

  // Translate a card's depends_on: remote display id -> remote uid -> local id.
  // Unresolvable entries (dangling on the peer, or pointing outside the pulled
  // set) are dropped and reported by DISPLAY id (never uid).
  const translateDeps = (rc, remoteId) => {
    const deps = Array.isArray(rc.depends_on) ? rc.depends_on : [];
    const out = [];
    for (const dep of deps) {
      const uid = remoteIdToUid.get(dep);
      const localId = uid ? uidToLocalId.get(uid) : undefined;
      if (localId) out.push(localId);
      else summary.droppedDeps.push({ project, card: remoteId, dep });
    }
    return out;
  };

  // Pass B: write winners wholesale (fields, goal, acceptance, logbook, uid,
  // updated, node all from the incoming card).
  const write = (rc, localId, fromState) => {
    const remoteId = rc.id; // the peer's display id for THIS card (for reporting)
    rc.id = localId;
    rc.project = project;
    rc.depends_on = translateDeps(rc, remoteId);
    rc.acceptance = Array.isArray(rc.acceptance) ? rc.acceptance : [];
    rc.logbook = Array.isArray(rc.logbook) ? rc.logbook : [];
    if (fromState !== undefined && fromState !== rc.state) {
      store.moveTask(project, localId, fromState, rc.state, rc);
    } else {
      store.writeTask(project, rc.state, rc);
    }
  };
  for (const { rc, localId } of inserts) { write(rc, localId); summary.added += 1; }
  for (const { rc, localId, fromState } of replaces) { write(rc, localId, fromState); summary.updated += 1; }
  // Every write above goes through store.writeTask/store.moveTask, which
  // already bumps the persisted id floor to each written id — no separate
  // floor update needed here.

  return { added: inserts.length, updated: replaces.length };
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
  // Cross-project epic: by slug when no project is given, or the fall-through
  // when the given project is one of its members (else it is not this project's
  // epic → EPIC_UNKNOWN).
  const x = store.readCrossEpic(slug);
  if (!x || (project !== undefined && !x.projects.includes(project))) {
    return fail('EPIC_UNKNOWN', `unknown epic: ${slug}`);
  }
  const tasks = sortTasks(
    x.projects.flatMap((p) => store.listTasks(p).filter((t) => t.epic === slug)),
  ).map(summary);
  return {
    ok: true,
    epic: { slug, title: x.title, goal: x.goal, rollup: crossRollup(slug, x.projects), projects: x.projects },
    tasks,
  };
}
