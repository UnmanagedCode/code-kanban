// Plain-text renderers for list_tasks / list_epics (the MCP raw-text channel —
// see src/mcp.js). Pure functions, no imports beyond STATES: no fs, no board.js,
// so a test can pin exact output strings without touching disk (mirrors
// code-conductor/src/mcp/readRenderers.ts's header comment).

import { STATES } from './paths.js';

const DASH = '—';

function dash(v) {
  return v === null || v === undefined || v === '' ? DASH : String(v);
}

// Whitespace collapsing is load-bearing: a title carrying a raw newline would
// otherwise split a row across lines and corrupt the whole listing.
function oneLine(s, max) {
  const collapsed = String(s).replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function isoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : DASH;
}

function heading(noun, n) {
  return `${noun} (${n === 0 ? 'none' : n})`;
}

function formatRow(t) {
  return {
    id: t.id,
    priority: dash(t.priority),
    title: oneLine(t.title, 100),
    created: isoDate(t.created),
    epic: t.epic,
    owner: t.owner,
    depends_on: t.depends_on,
    plan: t.plan,
  };
}

// Padded to the widest value ACROSS EVERY RENDERED ROW (not per-lane), so
// columns line up down the whole page.
function columnWidths(rows) {
  const w = { id: 0, priority: 0, title: 0, created: 0 };
  for (const r of rows) {
    w.id = Math.max(w.id, r.id.length);
    w.priority = Math.max(w.priority, r.priority.length);
    w.title = Math.max(w.title, r.title.length);
    w.created = Math.max(w.created, r.created.length);
  }
  return w;
}

// Tail facts are omitted entirely when unset (null/''/[]) — never printed as
// `epic —`, since a set-vs-unset distinction is exactly what a reader needs.
function renderRow(r, w) {
  const cells = [
    r.id.padEnd(w.id),
    r.priority.padEnd(w.priority),
    r.title.padEnd(w.title),
    r.created.padEnd(w.created),
  ].join('  ');
  const tail = [];
  if (r.epic) tail.push(`epic ${r.epic}`);
  if (r.owner) tail.push(`owner ${r.owner}`);
  if (Array.isArray(r.depends_on) && r.depends_on.length) tail.push(`deps ${r.depends_on.join(',')}`);
  if (r.plan) tail.push(`plan ${r.plan}`);
  const line = tail.length ? `${cells}  ${tail.join('  ')}` : cells;
  return `    ${line}`.trimEnd();
}

// `tasks` is already sorted by board.sortTasks (column -> priority -> id); this
// renderer never sorts — it only groups by iterating STATES and filtering, so
// lane order comes from paths.js and within-lane order is preserved exactly.
export function renderTaskList(tasks, opts = {}) {
  const { project, doneHidden, state = null, epic = null, everyLane = false } = opts;
  const clauses = [`${tasks.length} shown`];
  if (state !== null) clauses.push(`state ${state}`);
  if (epic !== null) clauses.push(`epic ${epic}`);
  if (doneHidden > 0) {
    clauses.push(`${doneHidden} done hidden (state:'done' to read them; includeDone:true for every lane)`);
  }
  if (everyLane === true) clauses.push('every lane');
  const header = `TASKS ${project} — ${clauses.join(' · ')}`;

  // An all-done board must read as "0 shown · N done hidden", never as an
  // empty board — the header alone carries that distinction.
  if (tasks.length === 0) return header;

  const rows = tasks.map(formatRow);
  const w = columnWidths(rows);
  const lines = [header, ''];
  for (const s of STATES) {
    const laneRows = rows.filter((_, i) => tasks[i].state === s);
    if (laneRows.length === 0) continue; // empty lane emits nothing; meta.counts already reports it
    lines.push(`▸ ${s} (${laneRows.length})`);
    for (const r of laneRows) lines.push(renderRow(r, w));
  }
  return lines.join('\n');
}

export function renderEpicList(epics, opts = {}) {
  const { project } = opts;
  const header = heading(`EPICS ${project}`, epics.length);
  if (epics.length === 0) return header;

  const lines = [header, ''];
  for (const e of epics) {
    let line = `▸ ${e.slug}  ${oneLine(dash(e.title), 100)}`;
    if (Array.isArray(e.projects) && e.projects.length) line += `  cross: ${e.projects.join(', ')}`;
    lines.push(line);
    // Every one of the five STATES is always printed — a rollup is a complete
    // count object, not an optional field; omitting a zero lane would make
    // `done 0` indistinguishable from "not computed".
    lines.push(`    ${STATES.map((s) => `${s} ${e.rollup[s]}`).join('  ')}`);
  }
  return lines.join('\n');
}
