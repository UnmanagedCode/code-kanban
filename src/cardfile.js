// Card markdown <-> object. Hand-rolled (no YAML dep) — the frontmatter is a
// small, fixed key set of scalars plus one string-array (depends_on). Body
// sections are Goal (free text), Acceptance (checkbox list) and Logbook
// (append-only lines). The `state` field is NOT stored in the file — it is the
// card's on-disk column dir, injected by the store on read.
//
// Cross-instance sync adds three scalars: `uid` (hidden stable identity — the
// sync match key), `updated` (UTC ISO-8601 version stamp, bumped by every
// mutator) and `node` (the machine that produced this version — the LWW
// tiebreak). `uid`/`node` are stripped from MCP/GUI reads (board.readCard); only
// /api/sync/export exposes them. See .wiki/architecture/cross-instance-sync.md.

import { normalizePriority } from './priority.js';

const SCALAR_KEYS = ['id', 'uid', 'title', 'project', 'epic', 'priority', 'created', 'updated', 'node', 'owner', 'commit', 'plan'];

function serializeDependsOn(deps) {
  return `[${(deps ?? []).join(', ')}]`;
}

function parseDependsOn(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((s) => s.trim()).filter(Boolean);
}

// task: {id,uid?,title,project,epic?,priority,created,updated?,node?,owner?,
//        commit?,plan?,depends_on[], goal, acceptance:[{text,done}], logbook:[string]}
// `plan` is a LINK to a plan file (src/planLink.js), never the plan text.
// `priority` is one of src/priority.js's PRIORITIES, or `null` for unset — and
// when unset the key is ABSENT from the frontmatter, like epic/owner/commit/plan.
// (A missing key is also what a pre-enum peer writes as `0`, so unset survives a
// round trip through one.) `parse` coerces a legacy value in memory, so any
// subsequent write persists it — the tolerant parse IS the migration.
// `serialize` normalises too, as a separate guard on a card object that never
// came through `parse`.
export function serialize(task) {
  const fm = [];
  fm.push(`id: ${task.id}`);
  if (task.uid) fm.push(`uid: ${task.uid}`);
  fm.push(`title: ${task.title ?? ''}`);
  fm.push(`project: ${task.project}`);
  if (task.epic) fm.push(`epic: ${task.epic}`);
  const priority = normalizePriority(task.priority);
  if (priority) fm.push(`priority: ${priority}`);
  fm.push(`created: ${task.created}`);
  if (task.updated) fm.push(`updated: ${task.updated}`);
  if (task.node) fm.push(`node: ${task.node}`);
  if (task.owner) fm.push(`owner: ${task.owner}`);
  if (task.commit) fm.push(`commit: ${task.commit}`);
  if (task.plan) fm.push(`plan: ${task.plan}`);
  fm.push(`depends_on: ${serializeDependsOn(task.depends_on)}`);

  return ['---', ...fm, '---', ''].join('\n') + serializeBody(task);
}

// The body half of the file format — Goal / Acceptance / Logbook, no
// frontmatter. Exported because `src/mcp.js` renders it as a raw markdown text
// block for prose-bearing reads; `serialize` is frontmatter + this, so there is
// exactly ONE renderer of the body shape and the two cannot drift.
export function serializeBody(task) {
  const accLines = (task.acceptance ?? []).map(
    (a) => `- [${a.done ? 'x' : ' '}] ${a.text}`,
  );
  return [
    '## Goal',
    (task.goal ?? '').trim(),
    '',
    '## Acceptance',
    ...(accLines.length ? accLines : []),
    '',
    '## Logbook',
    ...(task.logbook ?? []).map((l) => `- ${l}`),
    '',
  ].join('\n');
}

export function parse(text, { state } = {}) {
  const lines = text.split('\n');
  const task = {
    id: null, uid: null, title: '', project: '', epic: null, priority: null,
    created: null, updated: null, node: null, owner: null, commit: null, plan: null,
    depends_on: [], goal: '', acceptance: [], logbook: [], state: state ?? null,
  };

  // Frontmatter: between the first two `---` fences.
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    for (; i < lines.length && lines[i].trim() !== '---'; i++) {
      const line = lines[i];
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key === 'depends_on') task.depends_on = parseDependsOn(val);
      else if (key === 'priority') task.priority = normalizePriority(val);
      else if (SCALAR_KEYS.includes(key)) task[key] = val === '' ? (['epic', 'owner', 'commit', 'plan', 'uid', 'updated', 'node'].includes(key) ? null : val) : val;
    }
    i++; // skip closing fence
  }

  // Body: collect lines per `## Section`.
  const sections = {};
  let current = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const name = parseSectionHeader(line);
    if (name !== null) { current = name.toLowerCase(); sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }

  task.goal = (sections.goal ?? []).join('\n').trim();

  for (const line of sections.acceptance ?? []) {
    const item = parseAcceptanceLine(line.trim());
    if (item) task.acceptance.push(item);
  }

  for (const line of sections.logbook ?? []) {
    const entry = parseLogbookLine(line.trim());
    if (entry !== null) task.logbook.push(entry);
  }

  return task;
}

// ---- line parsers ----
// Card and epic files arrive from HTTP bodies, MCP args and sync peers, and are
// parsed synchronously on the thread that answers /api/health. Lines are split on
// `\n` only, so `\r`, U+2028 and U+2029 stay inside a line: `\s` matches them and
// `.` does not. The regexes these helpers stand in for (a `\s+` followed by
// `(.*)$` or `(.+?)\s*$`) backtrack through every split of a whitespace run
// before failing on such a character, which is quadratic or worse. Each helper
// scans by index instead and returns exactly what its regex captured, which
// tests/lineParsers.test.mjs pins against the regex itself. See
// .wiki/gotchas/linear-line-parsers.md.

const isSpace = (ch) => /\s/.test(ch);
// The characters `.` refuses: a capture that must be `.`-only cannot hold one.
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

// Index of the first non-`\s` character at or after `from`.
function skipSpace(line, from) {
  let i = from;
  while (i < line.length && isSpace(line[i])) i++;
  return i;
}

// `/^##\s+(.+?)\s*$/` → the section name, or null when the line is no header.
export function parseSectionHeader(line) {
  if (!line.startsWith('##')) return null;
  const run = skipSpace(line, 2);
  if (run === 2) return null;
  if (run === line.length) {
    // All whitespace after `##`: the name is the last character `.` accepts,
    // with at least one whitespace character left before it.
    for (let p = line.length - 1; p > 2; p--) if (!LINE_TERMINATOR.test(line[p])) return line[p];
    return null;
  }
  let end = line.length;
  while (isSpace(line[end - 1])) end--;
  const name = line.slice(run, end);
  return LINE_TERMINATOR.test(name) ? null : name;
}

// `/^-\s+\[( |x|X)\]\s+(.*)$/` → {text, done}, or null when the line is no item.
export function parseAcceptanceLine(line) {
  if (line[0] !== '-') return null;
  const open = skipSpace(line, 1);
  if (open === 1 || line[open] !== '[') return null;
  const mark = line[open + 1];
  if ((mark !== ' ' && mark !== 'x' && mark !== 'X') || line[open + 2] !== ']') return null;
  const textAt = skipSpace(line, open + 3);
  if (textAt === open + 3) return null;
  const text = line.slice(textAt);
  return LINE_TERMINATOR.test(text) ? null : { text, done: mark.toLowerCase() === 'x' };
}

// `/^-\s+(.*)$/` → the entry, or null when the line is no item. Card and epic
// logbooks share it.
export function parseLogbookLine(line) {
  if (line[0] !== '-') return null;
  const at = skipSpace(line, 1);
  if (at === 1) return null;
  const entry = line.slice(at);
  return LINE_TERMINATOR.test(entry) ? null : entry;
}

// Logbook entry format: "<ISO> · <sid8> · <entry>". sessionId is truncated to 8
// chars for attribution; null/absent becomes "conductor".
export function logLine(iso, sessionId, entry) {
  const sid = sessionId ? String(sessionId).slice(0, 8) : 'conductor';
  return `${iso} · ${sid} · ${entry}`;
}
