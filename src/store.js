import fs from 'node:fs';
import path from 'node:path';
import { STATES, projectDir, stateDir, epicsDir, plansDir, crossEpicsDir } from './paths.js';
import * as cardfile from './cardfile.js';

// File store for the board. Plain atomic filesystem operations only — the plugin
// is deliberately NOT a git writer inside .conduct (that would contend with the
// conductor's own index/commits). Per-card history lives in the Logbook; any git
// snapshotting of the board is the conductor's concern at its own cadence.
// All mutators here are called from board.js inside a per-project mutex, so
// scan-then-write sequences (id assignment, moves) are race-free.

export function ensureProjectDirs(project) {
  for (const s of STATES) fs.mkdirSync(stateDir(project, s), { recursive: true });
  fs.mkdirSync(epicsDir(project), { recursive: true });
  fs.mkdirSync(plansDir(project), { recursive: true });
}

// Atomic write: tmp file in the same dir + rename (rename is atomic within a
// filesystem, so a reader never sees a half-written card). Exported for
// board.js's plan ingest, which writes its copy the same way.
export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    // Best effort: a failed write or rename must not leave its temp file behind.
    try { fs.rmSync(tmp, { force: true }); } catch { /* the original error is the one to report */ }
    throw e;
  }
}

// A card id or epic slug names its record's FILE (`<name>.md`), so it must be one
// plain filename segment: a `/`, a `\\` or a `..` would point the path anywhere.
// The ONE rule for that, kept here because every record path is built here. Every
// reader below answers "no such record" for a non-segment (so board.js refuses
// CARD_UNKNOWN / EPIC_UNKNOWN with no check of its own), and every path builder
// throws on one, so a writer cannot be steered outside the board either.
const RECORD_NAME_RE = /^[A-Za-z0-9._-]+$/;
export function isRecordName(name) {
  return typeof name === 'string' && RECORD_NAME_RE.test(name) && name !== '.' && name !== '..';
}

function recordFile(dir, name) {
  if (!isRecordName(name)) throw new Error(`unsafe record name: ${JSON.stringify(name)}`);
  return path.join(dir, `${name}.md`);
}

function cardPath(project, state, id) {
  return recordFile(stateDir(project, state), id);
}

// Locate a card file by id across all state dirs. Returns {file, state} or null.
export function findCardFile(project, id) {
  if (!isRecordName(id)) return null;
  for (const state of STATES) {
    const file = cardPath(project, state, id);
    if (fs.existsSync(file)) return { file, state };
  }
  return null;
}

// ---- id sequence (persisted high-water mark) ----
//
// The sequence used to be derived purely by scanning existing card files for
// the max numeric suffix. That regresses the moment a card is deleted:
// unlinking the highest-numbered card lowers the live-scanned max, so the next
// nextId() call reuses the freed number — silently re-satisfying any dangling
// depends_on that pointed at the deleted card, and breaking the monotonic,
// never-reuse guarantee this sequence is supposed to hold (a deletion is
// SUPPOSED to leave a gap; it must never let that gap be re-filled). A
// persisted per-project floor file fixes this: writeCard bumps the floor to
// at least every id it ever actually commits to disk, and nextId() takes the
// max of that floor and the live scan — so once a card is written, deleting
// it later can never let its number come back.
//
// The bump lives in writeCard, NOT in nextId: nextId only proposes a candidate
// id and may be called speculatively without a following write (see
// tests/store.test.mjs's gap-free-sequence test, which peeks nextId() before
// ever writing) — persisting on the peek would burn ids that were never used.
//
// Purely local bookkeeping — NOT part of the sync wire format. Ids are already
// unique only per-project, per-filesystem (see
// .wiki/architecture/file-store-layout.md), so each machine enforces its own
// floor independently; board.js's sync merge seeds its own id allocator from
// idFloor() too, so a reassigned incoming card can't reuse a locally-deleted
// high id either — never against the peer's floor, which isn't on the wire.
//
// Sequence numbers are BigInt throughout: an id number is unbounded text, and a
// float stops counting at 2^53 (`2^53 + 1` rounds back down), so `max + 1` would
// re-mint an existing id and the merge's allocator would never find a free one.
function idFloorPath(project) {
  return path.join(projectDir(project), '.id-seq');
}

// Highest card-id number ever committed to disk in this project, including
// ids whose card has since been deleted. Read-only peek.
// -> BigInt (0n when absent or unreadable).
export function idFloor(project) {
  let text;
  try { text = fs.readFileSync(idFloorPath(project), 'utf8').trim(); }
  catch { return 0n; }
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

// Raise the persisted floor to at least `n` (a BigInt; never regress it).
function bumpIdFloor(project, n) {
  if (n > idFloor(project)) atomicWrite(idFloorPath(project), String(n));
}

// The display id for sequence number `seq` (a BigInt): `<year>-<NNNN>`, padded to
// four digits and never truncated. The one formatter — nextId and the sync merge's
// allocator (board.js's mergeProject) both mint through it.
export function formatId(year, seq) {
  return `${year}-${String(seq).padStart(4, '0')}`;
}

// Next id for a project: current year + a project-wide monotonic sequence.
// The sequence is the max of the persisted floor and the max numeric suffix
// across ALL existing cards, + 1, and does NOT reset on year rollover — ids
// stay globally sortable within a project and a deleted id is never reused;
// the year is a human-readable creation prefix only.
export function nextId(project) {
  let max = idFloor(project);
  for (const state of STATES) {
    let names;
    try { names = fs.readdirSync(stateDir(project, state)); }
    catch { continue; }
    for (const name of names) {
      const m = /-(\d+)\.md$/.exec(name);
      if (m) {
        const n = BigInt(m[1]);
        if (n > max) max = n;
      }
    }
  }
  return formatId(new Date().getFullYear(), max + 1n);
}

export function writeCard(project, state, task) {
  atomicWrite(cardPath(project, state, task.id), cardfile.serialize({ ...task, project }));
  const m = /-(\d+)$/.exec(task.id ?? '');
  if (m) bumpIdFloor(project, BigInt(m[1]));
}

export function readCardById(project, id) {
  const loc = findCardFile(project, id);
  if (!loc) return null;
  return cardfile.parse(fs.readFileSync(loc.file, 'utf8'), { state: loc.state });
}

// Move a card between state dirs by writing the (updated) card in the new dir
// and unlinking the old file — the new card appears before the old is removed.
export function moveCard(project, id, fromState, toState, updatedTask) {
  writeCard(project, toState, updatedTask);
  const oldFile = cardPath(project, fromState, id);
  if (fromState !== toState && fs.existsSync(oldFile)) fs.rmSync(oldFile);
}

// Permanently remove a card's file. Returns true if a card was found and
// deleted, false if none existed (the caller turns that into CARD_UNKNOWN).
export function deleteCard(project, id) {
  const loc = findCardFile(project, id);
  if (!loc) return false;
  fs.rmSync(loc.file);
  return true;
}

// Full cards in a project, parsed (all frontmatter incl. uid/updated/node),
// state injected, WITHOUT the _mtimeMs stat. This is the raw board dump the sync
// export serves and the sync merge consumes — the one place uid/node are exposed.
export function exportCards(project) {
  const out = [];
  for (const s of STATES) {
    let names;
    try { names = fs.readdirSync(stateDir(project, s)); }
    catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(stateDir(project, s), name), 'utf8');
      out.push(cardfile.parse(raw, { state: s }));
    }
  }
  return out;
}

// All cards in a project (optionally one state), parsed, with state injected.
export function listCards(project, { state } = {}) {
  const states = state ? [state] : STATES;
  const out = [];
  for (const s of states) {
    let names;
    try { names = fs.readdirSync(stateDir(project, s)); }
    catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(stateDir(project, s), name), 'utf8');
      const t = cardfile.parse(raw, { state: s });
      t._mtimeMs = fs.statSync(path.join(stateDir(project, s), name)).mtimeMs;
      out.push(t);
    }
  }
  return out;
}

// ---- epics ----

function epicPath(project, slug) {
  return recordFile(epicsDir(project), slug);
}

export function epicExists(project, slug) {
  return isRecordName(slug) && fs.existsSync(epicPath(project, slug));
}

// ---- the shared epic codec ----
//
// A project-scoped epic file and a cross-project one differ by exactly ONE
// frontmatter line, so both codec pairs below share these halves rather than
// hand-rolling the format twice (two copies is how the two drift when a field
// is added).
//
// `updated`/`node` are the cross-instance sync version stamp — the LWW clock and
// its tiebreak, mirroring cards (but epics have NO uid: their slug is identity).
// Emitted only when set; hidden from reads (board.readEpic/listEpics whitelist
// their output) — exposed only via /api/sync/export.

// `ownerLines` is the differing line: `project: <p>` or `projects: [a, b]`.
// `plan` is a LINK to the epic's plan file (src/planLink.js), never the plan
// text, and — like a card's — the key is absent when unset. `## Logbook` is
// always emitted, in the same `- <line>` shape cardfile.serializeBody uses, so
// one reading habit serves cards and epics.
function serializeEpicFile(epic, ownerLines) {
  return [
    '---',
    `slug: ${epic.slug}`,
    `title: ${epic.title ?? ''}`,
    ...ownerLines,
    ...(epic.plan ? [`plan: ${epic.plan}`] : []),
    `created: ${epic.created}`,
    ...(epic.updated ? [`updated: ${epic.updated}`] : []),
    ...(epic.node ? [`node: ${epic.node}`] : []),
    '---',
    '## Goal',
    (epic.goal ?? '').trim(),
    '',
    '## Logbook',
    ...(epic.logbook ?? []).map((l) => `- ${l}`),
    '',
  ].join('\n');
}

// `seed` is the fully-defaulted object the caller wants back, carrying the
// identity fields it already knows (slug, plus `project` or an empty `projects`
// list). A `projects:` line is read ONLY when the seed carries the list — a
// project-scoped epic ignores a stray one, exactly as before.
function parseEpicFile(text, seed) {
  const lines = text.split('\n');
  const epic = { ...seed };
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    for (; i < lines.length && lines[i].trim() !== '---'; i++) {
      const idx = lines[i].indexOf(':');
      if (idx === -1) continue;
      const key = lines[i].slice(0, idx).trim();
      const val = lines[i].slice(idx + 1).trim();
      // An empty timestamp reads as unset (null), as cardfile.parse does, so a
      // bare `updated:` still takes readers' `updated ?? created` fallback.
      if (key === 'created' || key === 'updated') epic[key] = val === '' ? null : val;
      else if (key === 'title' || key === 'node') epic[key] = val;
      else if (key === 'plan') epic.plan = val === '' ? null : val;
      else if (key === 'projects' && Array.isArray(epic.projects)) {
        const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
        epic.projects = inner ? inner.split(',').map((s) => s.trim()).filter(Boolean) : [];
      }
    }
    i++;
  }
  // Parsing `plan`/`logbook` is not optional once they are serialized: sync's
  // backfill READS THEN REWRITES any epic missing a version stamp, so a parser
  // that dropped them would let the next exportBoard destroy them on every
  // legacy epic (see .wiki/architecture/cross-instance-sync.md).
  const goal = [];
  let section = null;
  for (; i < lines.length; i++) {
    if (/^##\s+Goal/i.test(lines[i])) { section = 'goal'; continue; }
    if (/^##\s+Logbook/i.test(lines[i])) { section = 'logbook'; continue; }
    if (/^##\s+/.test(lines[i])) { section = null; continue; }
    if (section === 'goal') goal.push(lines[i]);
    else if (section === 'logbook') {
      const entry = cardfile.parseLogbookLine(lines[i].trim());
      if (entry !== null) epic.logbook.push(entry);
    }
  }
  epic.goal = goal.join('\n').trim();
  return epic;
}

export function writeEpic(project, epic) {
  atomicWrite(epicPath(project, epic.slug), serializeEpicFile(epic, [`project: ${project}`]));
}

export function readEpic(project, slug) {
  if (!isRecordName(slug)) return null;
  const file = epicPath(project, slug);
  if (!fs.existsSync(file)) return null;
  return parseEpicFile(fs.readFileSync(file, 'utf8'), {
    slug, title: '', project, plan: null, created: null, updated: null, node: null,
    goal: '', logbook: [],
  });
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
// a card's depends_on: `[a, b]`) instead of a single `project`.

function crossEpicPath(slug) {
  return recordFile(crossEpicsDir(), slug);
}

export function crossEpicExists(slug) {
  return isRecordName(slug) && fs.existsSync(crossEpicPath(slug));
}

export function writeCrossEpic(epic) {
  atomicWrite(
    crossEpicPath(epic.slug),
    serializeEpicFile(epic, [`projects: [${(epic.projects ?? []).join(', ')}]`]),
  );
}

export function readCrossEpic(slug) {
  if (!isRecordName(slug)) return null;
  const file = crossEpicPath(slug);
  if (!fs.existsSync(file)) return null;
  return parseEpicFile(fs.readFileSync(file, 'utf8'), {
    slug, title: '', projects: [], plan: null, created: null, updated: null, node: null,
    goal: '', logbook: [],
  });
}

export function listCrossEpicSlugs() {
  let names;
  try { names = fs.readdirSync(crossEpicsDir()); }
  catch { return []; }
  return names.filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, ''));
}
