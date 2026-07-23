import fs from 'node:fs';
import path from 'node:path';
import { STATES, projectDir, stateDir, epicsDir, crossEpicsDir } from './paths.js';
import * as taskfile from './taskfile.js';

// File store for the board. Plain atomic filesystem operations only — the plugin
// is deliberately NOT a git writer inside .conduct (that would contend with the
// conductor's own index/commits). Per-card history lives in the Logbook; any git
// snapshotting of the board is the conductor's concern at its own cadence.
// All mutators here are called from board.js inside a per-project mutex, so
// scan-then-write sequences (id assignment, moves) are race-free.

export function ensureProjectDirs(project) {
  for (const s of STATES) fs.mkdirSync(stateDir(project, s), { recursive: true });
  fs.mkdirSync(epicsDir(project), { recursive: true });
}

// Atomic write: tmp file in the same dir + rename (rename is atomic within a
// filesystem, so a reader never sees a half-written card).
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function taskPath(project, state, id) {
  return path.join(stateDir(project, state), `${id}.md`);
}

// Locate a task file by id across all state dirs. Returns {file, state} or null.
export function findTaskFile(project, id) {
  for (const state of STATES) {
    const file = taskPath(project, state, id);
    if (fs.existsSync(file)) return { file, state };
  }
  return null;
}

// Next id for a project: current year + a project-wide monotonic sequence.
// The sequence is the max numeric suffix across ALL existing cards + 1 and does
// NOT reset on year rollover — ids stay globally sortable and gap-free within a
// project; the year is a human-readable creation prefix only.
export function nextId(project) {
  let max = 0;
  for (const state of STATES) {
    let names;
    try { names = fs.readdirSync(stateDir(project, state)); }
    catch { continue; }
    for (const name of names) {
      const m = /-(\d+)\.md$/.exec(name);
      if (m) max = Math.max(max, Number.parseInt(m[1], 10));
    }
  }
  const year = new Date().getFullYear();
  return `${year}-${String(max + 1).padStart(4, '0')}`;
}

export function writeTask(project, state, task) {
  atomicWrite(taskPath(project, state, task.id), taskfile.serialize({ ...task, project }));
}

export function readTaskById(project, id) {
  const loc = findTaskFile(project, id);
  if (!loc) return null;
  return taskfile.parse(fs.readFileSync(loc.file, 'utf8'), { state: loc.state });
}

// Move a card between state dirs by writing the (updated) card in the new dir
// and unlinking the old file — the new card appears before the old is removed.
export function moveTask(project, id, fromState, toState, updatedTask) {
  writeTask(project, toState, updatedTask);
  const oldFile = taskPath(project, fromState, id);
  if (fromState !== toState && fs.existsSync(oldFile)) fs.rmSync(oldFile);
}

// All cards in a project (optionally one state), parsed, with state injected.
export function listTasks(project, { state } = {}) {
  const states = state ? [state] : STATES;
  const out = [];
  for (const s of states) {
    let names;
    try { names = fs.readdirSync(stateDir(project, s)); }
    catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(stateDir(project, s), name), 'utf8');
      const t = taskfile.parse(raw, { state: s });
      t._mtimeMs = fs.statSync(path.join(stateDir(project, s), name)).mtimeMs;
      out.push(t);
    }
  }
  return out;
}

// ---- epics ----

function epicPath(project, slug) {
  return path.join(epicsDir(project), `${slug}.md`);
}

export function epicExists(project, slug) {
  return fs.existsSync(epicPath(project, slug));
}

export function writeEpic(project, epic) {
  const parts = [
    '---',
    `slug: ${epic.slug}`,
    `title: ${epic.title ?? ''}`,
    `project: ${project}`,
    `created: ${epic.created}`,
    '---',
    '## Goal',
    (epic.goal ?? '').trim(),
    '',
  ];
  atomicWrite(epicPath(project, epic.slug), parts.join('\n'));
}

export function readEpic(project, slug) {
  const file = epicPath(project, slug);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const epic = { slug, title: '', project, created: null, goal: '' };
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    for (; i < lines.length && lines[i].trim() !== '---'; i++) {
      const idx = lines[i].indexOf(':');
      if (idx === -1) continue;
      const key = lines[i].slice(0, idx).trim();
      const val = lines[i].slice(idx + 1).trim();
      if (key === 'title' || key === 'created') epic[key] = val;
    }
    i++;
  }
  const goal = [];
  let inGoal = false;
  for (; i < lines.length; i++) {
    if (/^##\s+Goal/i.test(lines[i])) { inGoal = true; continue; }
    if (/^##\s+/.test(lines[i])) { inGoal = false; continue; }
    if (inGoal) goal.push(lines[i]);
  }
  epic.goal = goal.join('\n').trim();
  return epic;
}

export function listEpicSlugs(project) {
  let names;
  try { names = fs.readdirSync(epicsDir(project)); }
  catch { return []; }
  return names.filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, ''));
}

// ---- cross-project epics ----
// A top-level <slug>.md store. Same hand-rolled frontmatter as per-project
// epics, but keyed by slug alone and carrying a `projects` list (serialized like
// a task's depends_on: `[a, b]`) instead of a single `project`.

function crossEpicPath(slug) {
  return path.join(crossEpicsDir(), `${slug}.md`);
}

export function crossEpicExists(slug) {
  return fs.existsSync(crossEpicPath(slug));
}

export function writeCrossEpic(epic) {
  const parts = [
    '---',
    `slug: ${epic.slug}`,
    `title: ${epic.title ?? ''}`,
    `projects: [${(epic.projects ?? []).join(', ')}]`,
    `created: ${epic.created}`,
    '---',
    '## Goal',
    (epic.goal ?? '').trim(),
    '',
  ];
  atomicWrite(crossEpicPath(epic.slug), parts.join('\n'));
}

export function readCrossEpic(slug) {
  const file = crossEpicPath(slug);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const epic = { slug, title: '', projects: [], created: null, goal: '' };
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    for (; i < lines.length && lines[i].trim() !== '---'; i++) {
      const idx = lines[i].indexOf(':');
      if (idx === -1) continue;
      const key = lines[i].slice(0, idx).trim();
      const val = lines[i].slice(idx + 1).trim();
      if (key === 'title' || key === 'created') epic[key] = val;
      else if (key === 'projects') {
        const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
        epic.projects = inner ? inner.split(',').map((s) => s.trim()).filter(Boolean) : [];
      }
    }
    i++;
  }
  const goal = [];
  let inGoal = false;
  for (; i < lines.length; i++) {
    if (/^##\s+Goal/i.test(lines[i])) { inGoal = true; continue; }
    if (/^##\s+/.test(lines[i])) { inGoal = false; continue; }
    if (inGoal) goal.push(lines[i]);
  }
  epic.goal = goal.join('\n').trim();
  return epic;
}

export function listCrossEpicSlugs() {
  let names;
  try { names = fs.readdirSync(crossEpicsDir()); }
  catch { return []; }
  return names.filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, ''));
}
