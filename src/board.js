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
import { STATES } from './paths.js';
import { resolvePlanLink, classifyPlanInput, planBaseDir, isContained } from './planLink.js';
import { validateProject, listProjects } from './projects.js';
import { withLock } from './mutex.js';
import * as store from './store.js';
import { logLine } from './cardfile.js';
import { PRIORITIES, isPriority, priorityRank } from './priority.js';
import { localNodeId, deriveUid } from './nodeId.js';
import { headSha } from './git.js';
import { ownerCwd } from './ownerWorktree.js';

function fail(code, reason) { return { ok: false, code, reason }; }
function nowIso() { return new Date().toISOString(); }

// The `uid`/`updated`/`node` version stamp is hidden from every MCP/GUI read.
// summary() (list_cards / epics) already whitelists fields; readCard returns a
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

// An explicit commit lands verbatim in frontmatter (cardfile.js's `commit:
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

// Hard cap on a plan body served by read_card's includePlan. Deliberately
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

// Ingest: copy an absolute source INTO the board as the owning record's plan
// file and return the stored `board:<destName>` link. `destDir`/`destName` are
// supplied by the caller (a card's plans/<id>.md, an epic's plans/epic-<slug>.md,
// under that project's plans/ dir or the board-level one) — this function does
// not know which kind of record it is serving. Copy, never move — the source (a
// plan wake's ~/.claude/plans/<slug>.md, typically) is never touched or
// modified. An existing destination is overwritten: last write wins, no
// versioning, so re-attaching a revised plan simply replaces the board's copy.
// -> {link} | a fail('PLAN_UNKNOWN', …)
function ingestPlanFile(destDir, destName, source) {
  let stat;
  try { stat = fs.statSync(source); } // follows symlinks
  catch (e) { return fail('PLAN_UNKNOWN', `cannot read plan file at ${source}: ${e.message}`); }
  if (!stat.isFile()) return fail('PLAN_UNKNOWN', `plan source is not a regular file: ${source}`);

  const dest = path.join(destDir, destName);
  const link = `board:${destName}`;
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
    // store.ensureProjectDirs creates plans/, but updateCard never calls it —
    // a project dir predating that function has none.
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(source, dest);
  } catch (e) {
    return fail('PLAN_UNKNOWN', `could not copy plan file from ${source}: ${e.message}`);
  }
  return { link };
}

// The single set-time validator for a caller-supplied plan value, shared by
// update_card, file_card, create_epic and the GUI's PATCH route. -> {link} | a
// fail(). A pointer (`board:`/`repo:`/bare relative) is stat-validated and
// NOTHING is written; a bare absolute path is ingested (copied in). `destName`
// names the ingest destination, so the copy always lands on the owning record's
// own plan file — `<id>.md` for a card, `epic-<slug>.md` for an epic. `project`
// is null for a cross-project epic, which puts `board:` under the board-level
// plans/ dir and refuses `repo:` (see src/planLink.js).
function resolvePlanForSet(project, value, destName) {
  const c = classifyPlanInput(project, value);
  if (c.error) return fail(c.error.code, c.error.reason);
  if (c.kind === 'ingest') return ingestPlanFile(planBaseDir(project, 'board'), destName, c.source);
  if (!safePlanFile(project, c)) {
    return fail('PLAN_UNKNOWN', `no plan file at ${c.link} (resolved to ${c.path})`);
  }
  return { link: c.link };
}

const ACCEPTANCE_OPS = ['add', 'remove', 'rename', 'done'];

// The single set-time validator for update_card's fields.acceptance. Pure:
// (PRE-EDIT list, caller value) -> {list} | a fail(). Nothing here writes —
// updateCard's one store.writeCard stays the only mutation, so every refusal
// below leaves the card untouched. file_card's flat string[] CONTAINER is a
// different shape handled by resolveAcceptanceForFile; the per-item TEXT rules
// are shared, via cleanAcceptanceText.
function resolveAcceptanceForSet(current, value) {
  if (value === null) return { list: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return fail('INVALID_STATE', 'acceptance must be {ops:[…]}, {replace:[…]}, or null');
  }
  const hasOps = 'ops' in value;
  const hasReplace = 'replace' in value;
  if (hasOps === hasReplace) {
    return fail('INVALID_STATE', 'acceptance takes exactly one of ops or replace');
  }
  return hasReplace ? replaceAcceptance(current, value.replace) : applyAcceptanceOps(current, value.ops);
}

// A criterion is ONE `- [ ] <text>` line in the card file
// (cardfile.serializeBody), and cardfile.parse trims the line before matching.
// So text with a newline splits into a line the parser DROPS, and
// empty-after-trim fails the regex's `\s+` and vanishes. Both are silent data
// loss on the next read, so both are refused here and the stored value is the
// TRIMMED text.
function cleanAcceptanceText(text, prefix) {
  if (typeof text !== 'string') return { error: fail('INVALID_STATE', `${prefix}: text must be a string`) };
  if (/[\n\r]/.test(text)) return { error: fail('INVALID_STATE', `${prefix}: text must not contain a newline`) };
  const trimmed = text.trim();
  if (!trimmed) return { error: fail('INVALID_STATE', `${prefix}: text must be non-empty`) };
  return { text: trimmed };
}

// The container half of every caller-supplied list field, shared so the shape
// refusal has ONE wording. A PRESENT but non-array value is a refusal, never a
// silent `[]`: coercing it discards the whole field while still returning
// {ok:true, id}, so the caller has no signal and the card lands with an empty
// Acceptance section (see .wiki/gotchas/acceptance-line-round-trip.md).
// `undefined` and `null` both mean "not given" -> empty list, matching how
// fileCard already reads `priority` and `plan`, and how update_card's
// `acceptance: null` clears.
// -> {list} | a fail(). ITEM validation is the caller's: a criterion is
// line-shaped text, a dependency is a bare id.
function resolveListForSet(name, value) {
  if (value == null) return { list: [] };
  if (!Array.isArray(value)) {
    return fail('INVALID_STATE', `${name} must be an array of strings, or null`);
  }
  return { list: value };
}

// file_card's `acceptance: string[]` -> [{text, done:false}] | a fail(). Each item
// goes through cleanAcceptanceText — the SAME text validator update_card's ops and
// replace use — so the two mutators cannot disagree about what a criterion may
// contain, and the stored text is the TRIMMED value at filing time too.
function resolveAcceptanceForFile(value) {
  const box = resolveListForSet('acceptance', value);
  if (box.ok === false) return box;
  const list = [];
  for (let i = 0; i < box.list.length; i++) {
    const cleaned = cleanAcceptanceText(box.list[i], `acceptance[${i}]`);
    if (cleaned.error) return cleaned.error;
    list.push({ text: cleaned.text, done: false });
  }
  return { list };
}

// depends_on -> string[] | a fail(). Shared by fileCard and updateCard so the two
// cannot drift. A non-string id would reach serializeDependsOn's `[a, b]` join and
// come back as a stringified husk on the next parse.
function resolveDependsOnForSet(value) {
  const box = resolveListForSet('depends_on', value);
  if (box.ok === false) return box;
  for (let i = 0; i < box.list.length; i++) {
    if (typeof box.list[i] !== 'string') {
      return fail('INVALID_STATE', `depends_on[${i}]: must be a string`);
    }
  }
  return { list: box.list };
}

// The two `fields` keys update_card's generic loop assigns VERBATIM (see
// UPDATABLE/PRE_RESOLVED below) and the ONE place their shape refusals are
// worded. fileCard calls the same pair, so the two mutators cannot drift —
// the reason resolveDependsOnForSet is shared. `check*` rather than `resolve*`:
// there is no normalised value to hand back, only a verdict.
// A non-string `goal` reaches cardfile.serializeBody's `(task.goal ?? '').trim()`
// (src/cardfile.js:67) and THROWS from inside the file lock, breaking
// src/routes.js's "board.js never throws for a domain outcome" invariant. A
// non-string `title` is quieter and no better: cardfile.serialize's
// `title: ${task.title ?? ''}` (src/cardfile.js:41) stringifies it onto a
// one-line frontmatter key, and null/'' land a card with NO title at all.
// A title with a newline does NOT truncate on the next read — cardfile.parse reads
// frontmatter line-by-line as `key: value`, so the text after the newline becomes
// SIBLING frontmatter keys and the caller sets fields the title field never granted
// (see .wiki/gotchas/frontmatter-injection-via-one-line-keys.md). parse is last-wins
// on a duplicate key, so `id`/`uid` — serialized ABOVE `title` — are overwritten
// outright, and any key serialized below it only when truthy (`epic`, `priority`,
// `owner`, `commit`, `plan`) sticks whenever the card's own value is unset. Refused,
// not stripped, and on the RAW value like cleanAcceptanceText: space-joining prose
// would persist a title the caller never wrote while still answering {ok:true}.
// -> null when acceptable, else a fail().
function checkTitle(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return fail('INVALID_STATE', 'title is required and must be a non-empty string');
  }
  if (/[\n\r]/.test(value)) {
    return fail('INVALID_STATE', 'title must not contain a newline');
  }
  return null;
}

// `null` means "clear it": serializeBody's `?? ''` renders an absent goal as an
// empty Goal section, which is exactly what parse reads back.
function checkGoal(value) {
  if (value != null && typeof value !== 'string') {
    return fail('INVALID_STATE', 'goal must be a string, or null');
  }
  return null;
}

// Pass 1 (validate against the PRE-EDIT snapshot, normalise into `checked` —
// never mutates the caller's op objects, since `fields` is caller-owned) then
// Pass 2 (build the result via a tombstone Set, never an in-place splice) —
// this two-pass shape is what makes single-pass pre-edit index resolution true.
function applyAcceptanceOps(current, ops) {
  if (!Array.isArray(ops)) return fail('INVALID_STATE', 'acceptance.ops must be an array');
  const checked = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      return fail('INVALID_STATE', `acceptance.ops[${i}]: each op must be an object with an op field`);
    }
    if (!ACCEPTANCE_OPS.includes(op.op)) {
      return fail('INVALID_STATE', `acceptance.ops[${i}]: unknown op "${op.op}" (add, remove, rename, done)`);
    }
    if (op.op === 'add') {
      const cleaned = cleanAcceptanceText(op.text, `acceptance.ops[${i}] (add)`);
      if (cleaned.error) return cleaned.error;
      checked.push({ kind: 'add', text: cleaned.text });
      continue;
    }
    if (!Number.isInteger(op.index)) {
      return fail('INVALID_STATE', `acceptance.ops[${i}] (${op.op}): index must be an integer`);
    }
    if (op.index < 0 || op.index >= current.length) {
      return fail('INVALID_STATE', `acceptance.ops[${i}] (${op.op}): index ${op.index} is out of range (list has ${current.length} items)`);
    }
    if (op.op === 'remove') {
      checked.push({ kind: 'remove', index: op.index });
    } else if (op.op === 'rename') {
      const cleaned = cleanAcceptanceText(op.text, `acceptance.ops[${i}] (rename)`);
      if (cleaned.error) return cleaned.error;
      checked.push({ kind: 'rename', index: op.index, text: cleaned.text });
    } else {
      if (typeof op.done !== 'boolean') {
        return fail('INVALID_STATE', `acceptance.ops[${i}] (done): done must be true or false`);
      }
      checked.push({ kind: 'done', index: op.index, done: op.done });
    }
  }
  const next = current.map((a) => ({ text: a.text, done: a.done })); // copy; never alias the parsed card
  const removed = new Set();
  const appended = [];
  for (const op of checked) {
    if (op.kind === 'add') appended.push(op.text);
    else if (op.kind === 'remove') removed.add(op.index);
    else if (op.kind === 'rename') next[op.index].text = op.text;
    else next[op.index].done = op.done;
  }
  return {
    list: [...next.filter((_, i) => !removed.has(i)),
      ...appended.map((text) => ({ text, done: false }))],
  };
}

// Preserves ticks by TEXT, not index — first pre-edit occurrence wins on a
// duplicate pre-edit text; duplicate new texts all inherit the same flag (a
// Map lookup, not a consumption). The match is on the trimmed new text
// against the stored pre-edit text (already trimmed-equivalent).
function replaceAcceptance(current, replace) {
  if (!Array.isArray(replace)) return fail('INVALID_STATE', 'acceptance.replace must be an array of strings');
  const doneByText = new Map();
  for (const a of current) if (!doneByText.has(a.text)) doneByText.set(a.text, a.done);
  const list = [];
  for (let i = 0; i < replace.length; i++) {
    const cleaned = cleanAcceptanceText(replace[i], `acceptance.replace[${i}]`);
    if (cleaned.error) return cleaned.error;
    list.push({ text: cleaned.text, done: doneByText.get(cleaned.text) ?? false });
  }
  return { list };
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

// The plan-read half of every read path (read_card and read_epic), so the rule
// has ONE implementation: `plan_path` is returned always — null when there is no
// link or the stored link is ungrammatical (e.g. arrived by sync from a newer
// peer) — and a missing/unreadable plan FILE is never a refusal, just
// plan_body:null + plan_missing:true. plan_missing is false when the record
// simply has no link. `project` is null for a cross-project epic.
// -> {plan_path[, plan_body, plan_truncated, plan_missing]}
function planFields(project, link, includePlan) {
  const resolved = link ? resolvePlanLink(project, link) : null;
  const ok = resolved && !resolved.error ? resolved : null;
  const out = { plan_path: ok ? ok.path : null };
  if (includePlan) {
    const file = ok ? safePlanFile(project, ok) : null;
    const read = file ? readPlanBody(file) : null;
    out.plan_body = read ? read.body : null;
    out.plan_truncated = read ? read.truncated : false;
    out.plan_missing = link ? read === null : false;
  }
  return out;
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
// every other read in this file (listCards/readCard/etc).
function findOwnedInProgressCard(project, sessionId) {
  return store.listCards(project, { state: 'in-progress' })
    .filter((t) => t.owner === sessionId)
    .sort((a, b) => b._mtimeMs - a._mtimeMs)[0] ?? null;
}

// Scans every project for the session's owned in-progress card when logCard isn't
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
function sortCards(tasks) {
  return tasks.sort((a, b) =>
    STATES.indexOf(a.state) - STATES.indexOf(b.state)
    || priorityRank(a.priority) - priorityRank(b.priority)
    || a.id.localeCompare(b.id));
}

// ---- worker + conductor ----

// file_card's only non-default landing lanes — mirrors triage's legal exits
// (ALLOWED_TRANSITIONS has triage>backlog, triage>todo) rather than a separate list.
const CATEGORIES = ['todo', 'backlog'];

export async function fileCard({ project, title, goal, acceptance, epic, depends_on, category, priority, plan, sessionId } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  const badTitle = checkTitle(title);
  if (badTitle) return badTitle;
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
  // Same altitude as the plan grammar check: pure shape checks with no fs
  // access, refusing before an id is minted. The resolved values are consumed
  // inside the lock.
  const acc = resolveAcceptanceForFile(acceptance);
  if (acc.ok === false) return acc;
  const deps = resolveDependsOnForSet(depends_on);
  if (deps.ok === false) return deps;
  const badGoal = checkGoal(goal);
  if (badGoal) return badGoal;
  return withLock(project, () => {
    store.ensureProjectDirs(project);
    if (epic && !epicVisibleIn(project, epic)) {
      return fail('EPIC_UNKNOWN', `unknown epic: ${epic} (create it first with create_epic)`);
    }
    const id = store.nextId(project);
    // Copy-then-write: a refused plan returns BEFORE store.writeCard, so no card
    // is created and no id is burned (the floor is bumped by writeCard, not
    // nextId — so the next file_card gets this same id).
    let planLink = null;
    if (plan != null) {
      const resolved = resolvePlanForSet(project, plan, `${id}.md`);
      if (resolved.ok === false) return resolved;
      planLink = resolved.link;
    }
    const created = nowIso();
    const task = {
      id, uid: crypto.randomUUID(), title: title.trim(), project, epic: epic ?? null,
      priority: priority ?? null, created, updated: created, node: localNodeId(),
      owner: null, plan: planLink, depends_on: deps.list,
      goal: goal ?? '',
      acceptance: acc.list,
      logbook: [logLine(created, sessionId, 'filed')],
    };
    store.writeCard(project, category ?? 'triage', task);
    // Report the resolved link only when `plan` was part of the call, so no
    // existing response shape changes.
    return plan != null ? { ok: true, id, plan: planLink } : { ok: true, id };
  });
}

// Permanent removal — no undo, no logbook (the file is gone). Not sync-aware:
// see docs/architecture.md's grow-only note and delete_card's tool description.
export async function deleteCard({ project, id } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  return withLock(project, () => {
    // Read the card BEFORE deleting so the plan link is still available; the
    // card file is the authoritative op and goes first.
    const task = store.readCardById(project, id);
    if (!store.deleteCard(project, id)) return fail('CARD_UNKNOWN', `unknown card: ${id}`);
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
//   this returns CARD_UNKNOWN. Logged with conductor attribution (logLine's
//   sessionId ?? 'conductor' convention — see cardfile.js), matching how moveCard
//   attributes its own logbook lines.
// - `id` omitted (worker path): resolves the in-progress card owned by
//   sessionId server-side. Workers never handle a card id. `project`, if given,
//   scopes the lookup directly (fast path); if omitted, every project is scanned for
//   the owned card. If a session owns MORE THAN ONE in-progress card, resolve to the
//   most recently modified one, across projects when scanning.
// (see .wiki/gotchas/owner-from-caller-sessionid.md)
export async function logCard({ project, id, entry, sessionId } = {}) {
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
      const task = store.readCardById(project, id);
      if (!task || task.state !== 'in-progress') {
        return fail('CARD_UNKNOWN', `no in-progress card: ${id}`);
      }
      task.logbook.push(logLine(nowIso(), null, entry.trim()));
      store.writeCard(project, 'in-progress', touch(task));
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
    return fail('CARD_UNKNOWN', 'no session id — cannot resolve an owned in-progress card');
  }
  const targetProject = project !== undefined ? project : await resolveOwningProject(sessionId);
  if (targetProject === null) {
    return fail('CARD_UNKNOWN', 'no in-progress card owned by this session');
  }
  return withLock(targetProject, () => {
    // Re-verify under the lock: if the card lost ownership or left in-progress
    // between the unlocked scan above and here, this returns CARD_UNKNOWN rather
    // than falling back to re-scan other projects (untested — see
    // .wiki/gotchas/owner-from-caller-sessionid.md).
    const task = findOwnedInProgressCard(targetProject, sessionId);
    if (!task) {
      return fail('CARD_UNKNOWN', 'no in-progress card owned by this session');
    }
    task.logbook.push(logLine(nowIso(), sessionId, entry.trim()));
    store.writeCard(targetProject, 'in-progress', touch(task));
    return { ok: true };
  });
}

// Appends to an EPIC's logbook. There is deliberately NO lane gate — an epic has
// no state and no owner, and the two entries most worth having (a resequencing
// decision before any card starts, a retrospective after the last one lands) both
// happen with no in-progress card. So EPIC_UNKNOWN is the only refusal here.
// Conductor-only: entries are always conductor-attributed, since an epic has no
// owner to credit.
export async function logEpic({ project, slug, entry } = {}) {
  if (project !== undefined) {
    const bad = await requireProject(project);
    if (bad) return bad;
  }
  if (typeof entry !== 'string' || !entry.trim()) {
    return fail('INVALID_STATE', 'entry is required and must be a non-empty string');
  }
  const t = resolveEpic(project, slug);
  if (!t) return fail('EPIC_UNKNOWN', `unknown epic: ${slug}`);
  return withLock(epicLockKey(t), () => {
    // Re-read under the lock — the resolve above ran unlocked.
    const fresh = rereadEpic(t);
    if (!fresh) return fail('EPIC_UNKNOWN', `unknown epic: ${slug}`);
    fresh.epic.logbook.push(logLine(nowIso(), null, entry.trim())); // conductor attribution
    // touch() is load-bearing: an edit that does not move `updated` is
    // invisible to the LWW merge.
    writeResolvedEpic({ ...fresh, epic: touch(fresh.epic) });
    return { ok: true };
  });
}

// ---- conductor: reads ----

export async function listCards({ project, state, epic } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (state && !STATES.includes(state)) return fail('INVALID_STATE', `unknown state: ${state}`);
  let tasks = store.listCards(project, { state });
  if (epic) tasks = tasks.filter((t) => t.epic === epic);
  return { ok: true, cards: sortCards(tasks).map(summary) };
}

// Envelope: {ok, card, plan_path, plan_body?, plan_truncated?, plan_missing?}.
// The plan fields sit TOP-LEVEL (never inside `card`, which mirrors frontmatter
// 1:1). `plan_path` is returned always — null when there is no link or the
// stored link is ungrammatical (e.g. arrived by sync from a newer peer). A plan
// file that is missing/unreadable is NEVER a refusal: plan_body:null +
// plan_missing:true. plan_missing is false when the card simply has no link.
export async function readCard({ project, id, logTail, includePlan } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  const task = store.readCardById(project, id);
  if (!task) return fail('CARD_UNKNOWN', `unknown card: ${id}`);
  if (Number.isFinite(logTail) && logTail >= 0) {
    // slice(-0) === slice(0) returns everything, so compute the start index
    // explicitly — logTail:0 must yield 0 entries (matches read_card_log limit:0).
    task.logbook = task.logbook.slice(Math.max(0, task.logbook.length - logTail));
  }
  delete task._mtimeMs;
  const plan = task.plan;
  return { ok: true, card: stripHidden(task), ...planFields(project, plan, includePlan) };
}

export async function readCardLog({ project, id, limit } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  const task = store.readCardById(project, id);
  if (!task) return fail('CARD_UNKNOWN', `unknown card: ${id}`);
  return tail(task.logbook, limit);
}

// A card's logbook, most-recent first, optionally capped. (An epic's logbook is
// read by readEpic, in chronological order — see
// .wiki/architecture/card-epic-tool-split.md.)
function tail(logbook, limit) {
  const recent = [...logbook].reverse();
  const entries = Number.isFinite(limit) && limit >= 0 ? recent.slice(0, limit) : recent;
  return { ok: true, entries, total: logbook.length };
}

// ---- conductor: mutations ----

export async function moveCard({ project, id, to, owner, commit } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (!STATES.includes(to)) return fail('INVALID_STATE', `unknown target state: ${to}`);
  return withLock(project, async () => {
    const task = store.readCardById(project, id);
    if (!task) return fail('CARD_UNKNOWN', `unknown card: ${id}`);
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
    store.moveCard(project, id, from, to, touch(task));
    return { ok: true, from, to };
  });
}

const UPDATABLE = ['title', 'goal', 'epic', 'priority', 'depends_on', 'plan', 'owner', 'acceptance'];

// Fields with their own set-time validator above the loop — the loop's
// `task[key] = fields[key]` is only for the ones that land verbatim.
const PRE_RESOLVED = ['plan', 'owner', 'acceptance', 'depends_on'];

export async function updateCard({ project, id, fields } = {}) {
  const bad = await requireProject(project);
  if (bad) return bad;
  if (!fields || typeof fields !== 'object') return fail('INVALID_STATE', 'fields object is required');
  return withLock(project, () => {
    const task = store.readCardById(project, id);
    if (!task) return fail('CARD_UNKNOWN', `unknown card: ${id}`);
    // First in the prologue, ahead of the epic/priority checks and — load-bearing
    // — ahead of resolvePlanForSet, the ONLY step up here with a side effect (an
    // absolute `plan` is COPIED into plans/). So a call mixing a bad title/goal
    // with an absolute plan path ingests no file. These two are also the only
    // keys the generic loop below assigns verbatim, so refusing here is what
    // makes "validates before any mutation" true for them.
    if ('title' in fields) {
      const bad = checkTitle(fields.title);
      if (bad) return bad;
    }
    if ('goal' in fields) {
      const bad = checkGoal(fields.goal);
      if (bad) return bad;
    }
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
    // single store.writeCard at the end — `task` is an in-memory parse, so
    // nothing is PERSISTED on a refusal path regardless of this ordering.
    let planNext;
    if ('plan' in fields) {
      if (fields.plan === null) planNext = null;
      else {
        const resolved = resolvePlanForSet(project, fields.plan, `${id}.md`);
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
    let acceptanceNext;
    if ('acceptance' in fields) {
      const resolved = resolveAcceptanceForSet(task.acceptance, fields.acceptance);
      if (resolved.ok === false) return resolved;
      acceptanceNext = resolved.list;
    }
    let dependsOnNext;
    if ('depends_on' in fields) {
      const resolved = resolveDependsOnForSet(fields.depends_on);
      if (resolved.ok === false) return resolved;
      dependsOnNext = resolved.list;
    }
    for (const key of UPDATABLE) {
      if (!(key in fields) || PRE_RESOLVED.includes(key)) continue;
      task[key] = fields[key]; // priority is validated above, so it lands verbatim (incl. null)
    }
    if ('plan' in fields) task.plan = planNext;
    if ('acceptance' in fields) task.acceptance = acceptanceNext;
    if ('depends_on' in fields) task.depends_on = dependsOnNext;
    if ('owner' in fields) {
      const prev = task.owner ?? null;
      // Only a real change is logged (a no-op set stamps nothing) — the line is
      // the handoff audit trail, mirroring moveCard's `moved <from> -> <to>`.
      if (prev !== ownerNext) {
        task.owner = ownerNext;
        task.logbook.push(logLine(nowIso(), null, `owner ${prev ?? 'none'} -> ${ownerNext ?? 'none'}`));
      }
    }
    store.writeCard(project, task.state, touch(task));
    // Report the stored link (an ingest's destination is `board:<id>.md`, which
    // the caller would otherwise have to infer) only when `plan` was in the call.
    return 'plan' in fields ? { ok: true, plan: planNext } : { ok: true };
  });
}

// ---- epics ----
//
// An epic is EITHER project-scoped (a <project>/epics/<slug>.md record) OR
// cross-project (a top-level epics/<slug>.md record naming ≥2 member projects).
// Cards join either kind via the same `epic: <slug>` field. A slug is never both
// at once for a given project: createEpic refuses the collision (EPIC_CONFLICT),
// so a card's epic slug resolves unambiguously — to the cross-project epic if one
// covers the card's project, else the project's own per-project epic.

const SLUG_RE = /^[a-z0-9._-]+$/;

// Sole lock key for the top-level cross-project store. Distinct from every
// project name (those match projects.NAME_RE, which forbids a leading space), so
// cross-epic writes serialize among themselves without touching a project mutex —
// the per-project single-writer invariant is preserved.
const CROSS_LOCK = ' cross-epics';

// Does slug `slug` name an epic visible to cards in `project`? True if the
// project has its own epic file, OR a cross-project epic covering the project.
function epicVisibleIn(project, slug) {
  if (store.epicExists(project, slug)) return true;
  const x = store.readCrossEpic(slug);
  return !!x && x.projects.includes(project);
}

// The ONE epic resolver: readEpic and logEpic both route
// through it, so the two can never disagree about which record a
// (project, slug) pair names. A project-scoped epic wins when `project` is
// given (the EPIC_CONFLICT guard makes that unambiguous), else a cross-project
// epic covering it; with no `project`, a cross epic by slug alone. A cross epic
// addressed with a NON-member project is not that project's epic.
// -> {kind:'project', project, epic} | {kind:'cross', epic} | null
function resolveEpic(project, slug) {
  if (project !== undefined) {
    const e = store.readEpic(project, slug);
    if (e) return { kind: 'project', project, epic: e };
  }
  const x = store.readCrossEpic(slug);
  if (!x || (project !== undefined && !x.projects.includes(project))) return null;
  return { kind: 'cross', epic: x };
}

// A cross epic's writes serialize on CROSS_LOCK, a project epic's on its own
// project mutex — the same single-writer mechanism keyed on the owning domain.
function epicLockKey(t) { return t.kind === 'cross' ? CROSS_LOCK : t.project; }

// The `project` a resolved epic's plan link resolves against — null for a cross
// epic, which has no owning project (its `board:` base is board-level).
function epicPlanScope(t) { return t.kind === 'cross' ? null : t.project; }

// Re-read a resolved epic's record, KEEPING the resolved kind — so a mutator
// re-reading under its lock stays on the record whose lock it took.
function rereadEpic(t) {
  const e = t.kind === 'cross'
    ? store.readCrossEpic(t.epic.slug)
    : store.readEpic(t.project, t.epic.slug);
  return e ? { ...t, epic: e } : null;
}

function writeResolvedEpic(t) {
  if (t.kind === 'cross') store.writeCrossEpic(t.epic);
  else store.writeEpic(t.project, t.epic);
}

// Preserve-on-omit for an epic's `goal`: an OMITTED key keeps the stored value,
// an explicit '' or null clears it. Tested with `!== undefined`, NEVER with
// `'goal' in args`: src/routes.js destructures the request body and passes an
// object literal, so the key is always present holding `undefined` — an `in`
// test would make every GUI epic re-post silently clobber the goal.
function preservedGoal(goal, existing) {
  return goal !== undefined ? (goal ?? '') : (existing?.goal ?? '');
}

// Same upsert semantics for an epic's `plan` — omitted preserves, null clears,
// anything else validates + sets through the one shared validator. An ingest
// lands on `plans/epic-<slug>.md`: the `epic-` prefix is load-bearing, since
// SLUG_RE admits a card-id-shaped slug (`2026-0001`) and an unprefixed name
// would overwrite that card's own plan file. -> {link} | a fail().
function resolveEpicPlanForSet(scope, slug, plan, existing) {
  if (plan === undefined) return { link: existing?.plan ?? null };
  if (plan === null) return { link: null };
  return resolvePlanForSet(scope, plan, `epic-${slug}.md`);
}

export async function createEpic({ project, projects, slug, title, goal, plan } = {}) {
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
  // Grammar-only pre-check before any lock, mirroring fileCard: a malformed plan
  // value writes nothing. The value is RESOLVED (stat/copy) inside the lock.
  if (plan !== undefined && plan !== null) {
    const c = classifyPlanInput(isCross ? null : project, plan);
    if (c.error) return fail(c.error.code, c.error.reason);
  }
  return isCross
    ? createCrossEpic({ projects, slug, title, goal, plan })
    : createProjectEpic({ project, slug, title, goal, plan });
}

async function createProjectEpic({ project, slug, title, goal, plan }) {
  const bad = await requireProject(project);
  if (bad) return bad;
  return withLock(project, () => {
    // Guard: a cross-project epic covering this project owns the slug.
    const x = store.readCrossEpic(slug);
    if (x && x.projects.includes(project)) {
      return fail('EPIC_CONFLICT', `slug ${slug} is a cross-project epic covering ${project}`);
    }
    store.ensureProjectDirs(project);
    // Upsert: create, or refresh an existing epic (idempotent). `title` always
    // overwrites; every OPTIONAL field a caller omits is PRESERVED — including
    // the logbook, which no caller can pass and an upsert must never wipe.
    const existing = store.readEpic(project, slug);
    const resolved = resolveEpicPlanForSet(project, slug, plan, existing);
    if (resolved.ok === false) return resolved;
    store.writeEpic(project, {
      slug, title: title.trim(), goal: preservedGoal(goal, existing),
      plan: resolved.link, logbook: existing?.logbook ?? [],
      created: existing?.created ?? nowIso(),
      updated: nowIso(), node: localNodeId(), // sync version stamp (see writeEpic)
    });
    // Report the stored link (an ingest's destination is `board:epic-<slug>.md`,
    // which the caller would otherwise have to infer) only when `plan` was in
    // the call, so no existing response shape changes.
    return plan !== undefined ? { ok: true, plan: resolved.link } : { ok: true };
  });
}

async function createCrossEpic({ projects, slug, title, goal, plan }) {
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
    // scope null: a cross epic has no owning project, so its plan resolves
    // under the BOARD-LEVEL plans/ dir (and `repo:` is refused).
    const resolved = resolveEpicPlanForSet(null, slug, plan, existing);
    if (resolved.ok === false) return resolved;
    store.writeCrossEpic({
      slug, title: title.trim(), goal: preservedGoal(goal, existing), projects: members,
      plan: resolved.link, logbook: existing?.logbook ?? [],
      created: existing?.created ?? nowIso(),
      updated: nowIso(), node: localNodeId(), // sync version stamp (see writeEpic)
    });
    return plan !== undefined ? { ok: true, plan: resolved.link } : { ok: true };
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
  const cards = store.exportCards(project);
  for (const c of cards) {
    if (ensureIdentity(c, project)) store.writeCard(project, c.state, c);
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

// Normalise an INCOMING remote epic's body fields before it can reach the store,
// mirroring what mergeProject's `write` already does for a card's
// acceptance/logbook. Without this a peer serving `logbook: "GARBAGE"` makes
// serializeEpicFile's .map() throw — and because the cross-epic merge runs
// BEFORE the per-project loop, that throw rejects the ENTIRE syncPull, so
// well-formed cards fail to merge too. `plan` must additionally be one clean
// line: it lands verbatim on a frontmatter key, the same hazard parsePlanLink
// refuses at set time. A value that fails either check is dropped, not repaired
// — a dead/absent link degrades to plan_missing, which every read handles.
// In-memory only, and it touches NO identity field, so the kind-conflict guards
// still run unchanged on the normalised record.
//
// Epics are DELIBERATELY stricter than cards here: the card path has the same
// hole on `goal` (cardfile.serializeBody's `(task.goal ?? '').trim()`), left
// alone on purpose and tracked as card 2026-0026. Not an oversight — fixing the
// card side is that card's job, and the asymmetry is temporary.
function normalizeRemoteEpic(epic) {
  return {
    ...epic,
    // `(epic.goal ?? '').trim()` in store.js coalesces null/undefined only, so a
    // number or object goal throws on .trim().
    goal: typeof epic.goal === 'string' ? epic.goal : '',
    plan: (typeof epic.plan === 'string' && !/[\n\r]/.test(epic.plan) && epic.plan.trim())
      ? epic.plan.trim() : null,
    logbook: Array.isArray(epic.logbook) ? epic.logbook.filter((l) => typeof l === 'string') : [],
  };
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
    // Members must be usable project NAMES before anything indexes a path with
    // them: a non-string throws in path.join, inside withLock(CROSS_LOCK) and so
    // before the per-project card loop — killing the whole pull. An empty string
    // is dropped too, since writeCrossEpic's `[a, b]` list is re-read with
    // .filter(Boolean) and would silently lose it on the next parse anyway.
    // This runs BEFORE the length check on purpose, so a list that is short only
    // once the junk is gone is skipped-and-reported rather than half-written.
    // NB a member naming a project absent from THIS machine is legitimate and
    // kept — a cross epic may span projects only the peer has.
    const members = Array.isArray(re.projects)
      ? [...new Set(re.projects.filter((p) => typeof p === 'string' && p.trim() !== ''))]
      : [];
    if (members.length < 2) { summary.skippedEpics.push({ slug: re.slug, kind: 'cross' }); continue; }
    if (!members.some((p) => localProjects.has(p))) continue; // covers no local project — irrelevant
    const clash = members.find((p) => store.epicExists(p, re.slug));
    if (clash) { summary.epicConflicts.push({ slug: re.slug, kind: 'cross-vs-project', project: clash }); continue; }
    const safe = normalizeRemoteEpic(re);
    ensureEpicIdentity(safe);
    const local = localBySlug.get(safe.slug);
    if (!local) { store.writeCrossEpic({ ...safe, projects: members }); summary.epicsAdded += 1; }
    else if (remoteWins(safe, local)) { store.writeCrossEpic({ ...safe, projects: members }); summary.epicsUpdated += 1; }
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
    const safe = normalizeRemoteEpic(re);
    ensureEpicIdentity(safe);
    const local = localBySlug.get(safe.slug);
    if (!local) { store.writeEpic(project, safe); summary.epicsAdded += 1; }
    else if (remoteWins(safe, local)) { store.writeEpic(project, safe); summary.epicsUpdated += 1; }
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

  // Validate incoming shape before it can reach deriveUid/writeCard: a card
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
      store.moveCard(project, localId, fromState, rc.state, rc);
    } else {
      store.writeCard(project, rc.state, rc);
    }
  };
  for (const { rc, localId } of inserts) { write(rc, localId); summary.added += 1; }
  for (const { rc, localId, fromState } of replaces) { write(rc, localId, fromState); summary.updated += 1; }
  // Every write above goes through store.writeCard/store.moveCard, which
  // already bumps the persisted id floor to each written id — no separate
  // floor update needed here.

  return { added: inserts.length, updated: replaces.length };
}

// Per-state counts for a project-scoped epic (one project's cards).
function rollup(project, slug) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const t of store.listCards(project)) {
    if (t.epic === slug) counts[t.state] += 1;
  }
  return counts;
}

// Per-state counts for a cross-project epic, aggregated across all members.
function crossRollup(slug, members) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const p of members) {
    for (const t of store.listCards(p)) {
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

// Envelope: {ok, epic, logbook_total, plan_path[, plan_body, plan_truncated,
// plan_missing], cards}. Like read_card, the plan fields sit TOP-LEVEL and `epic`
// mirrors the record (minus the hidden updated/node stamp — the response is a
// field whitelist), so `logbook_total` — the FULL logbook length, before any
// logTail cap, which is what tells a tail'd caller 5 entries from 50 — sits
// top-level too rather than inside `epic`.
export async function readEpic({ project, slug, logTail, includePlan } = {}) {
  if (project !== undefined) {
    const bad = await requireProject(project);
    if (bad) return bad;
  }
  const t = resolveEpic(project, slug);
  if (!t) return fail('EPIC_UNKNOWN', `unknown epic: ${slug}`);
  const e = t.epic;
  const isCross = t.kind === 'cross';
  const members = isCross ? e.projects : [t.project];
  const cards = sortCards(
    members.flatMap((p) => store.listCards(p).filter((x) => x.epic === slug)),
  ).map(summary);
  let logbook = e.logbook ?? [];
  const logbookTotal = logbook.length;
  if (Number.isFinite(logTail) && logTail >= 0) {
    // slice(-0) === slice(0) returns everything, so compute the start index
    // explicitly — logTail:0 must yield 0 entries (same trap as readCard).
    logbook = logbook.slice(Math.max(0, logbook.length - logTail));
  }
  const epic = {
    slug, title: e.title, goal: e.goal, plan: e.plan ?? null,
    rollup: isCross ? crossRollup(slug, e.projects) : rollup(t.project, slug),
    ...(isCross ? { projects: e.projects } : {}),
    logbook,
  };
  return { ok: true, epic, logbook_total: logbookTotal, ...planFields(epicPlanScope(t), e.plan, includePlan), cards };
}
