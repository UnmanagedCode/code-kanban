// Task markdown <-> object. Hand-rolled (no YAML dep) — the frontmatter is a
// small, fixed key set of scalars plus one string-array (depends_on). Body
// sections are Goal (free text), Acceptance (checkbox list) and Logbook
// (append-only lines). The `state` field is NOT stored in the file — it is the
// task's on-disk column dir, injected by the store on read.
//
// Cross-instance sync adds three scalars: `uid` (hidden stable identity — the
// sync match key), `updated` (UTC ISO-8601 version stamp, bumped by every
// mutator) and `node` (the machine that produced this version — the LWW
// tiebreak). `uid`/`node` are stripped from MCP/GUI reads (board.readTask); only
// /api/sync/export exposes them. See .wiki/architecture/cross-instance-sync.md.

const SCALAR_KEYS = ['id', 'uid', 'title', 'project', 'epic', 'priority', 'created', 'updated', 'node', 'owner', 'commit'];

function serializeDependsOn(deps) {
  return `[${(deps ?? []).join(', ')}]`;
}

function parseDependsOn(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((s) => s.trim()).filter(Boolean);
}

// task: {id,uid?,title,project,epic?,priority,created,updated?,node?,owner?,
//        commit?,depends_on[], goal, acceptance:[{text,done}], logbook:[string]}
export function serialize(task) {
  const fm = [];
  fm.push(`id: ${task.id}`);
  if (task.uid) fm.push(`uid: ${task.uid}`);
  fm.push(`title: ${task.title ?? ''}`);
  fm.push(`project: ${task.project}`);
  if (task.epic) fm.push(`epic: ${task.epic}`);
  fm.push(`priority: ${Number.isFinite(task.priority) ? task.priority : 0}`);
  fm.push(`created: ${task.created}`);
  if (task.updated) fm.push(`updated: ${task.updated}`);
  if (task.node) fm.push(`node: ${task.node}`);
  if (task.owner) fm.push(`owner: ${task.owner}`);
  if (task.commit) fm.push(`commit: ${task.commit}`);
  fm.push(`depends_on: ${serializeDependsOn(task.depends_on)}`);

  const accLines = (task.acceptance ?? []).map(
    (a) => `- [${a.done ? 'x' : ' '}] ${a.text}`,
  );
  const parts = [
    '---',
    ...fm,
    '---',
    '## Goal',
    (task.goal ?? '').trim(),
    '',
    '## Acceptance',
    ...(accLines.length ? accLines : []),
    '',
    '## Logbook',
    ...(task.logbook ?? []).map((l) => `- ${l}`),
    '',
  ];
  return parts.join('\n');
}

export function parse(text, { state } = {}) {
  const lines = text.split('\n');
  const task = {
    id: null, uid: null, title: '', project: '', epic: null, priority: 0,
    created: null, updated: null, node: null, owner: null, commit: null,
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
      else if (key === 'priority') task.priority = Number.parseInt(val, 10) || 0;
      else if (SCALAR_KEYS.includes(key)) task[key] = val === '' ? (['epic', 'owner', 'commit', 'uid', 'updated', 'node'].includes(key) ? null : val) : val;
    }
    i++; // skip closing fence
  }

  // Body: collect lines per `## Section`.
  const sections = {};
  let current = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { current = m[1].toLowerCase(); sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }

  task.goal = (sections.goal ?? []).join('\n').trim();

  for (const line of sections.acceptance ?? []) {
    const m = /^-\s+\[( |x|X)\]\s+(.*)$/.exec(line.trim());
    if (m) task.acceptance.push({ text: m[2], done: m[1].toLowerCase() === 'x' });
  }

  for (const line of sections.logbook ?? []) {
    const m = /^-\s+(.*)$/.exec(line.trim());
    if (m) task.logbook.push(m[1]);
  }

  return task;
}

// Logbook entry format: "<ISO> · <sid8> · <entry>". sessionId is truncated to 8
// chars for attribution; null/absent becomes "conductor".
export function logLine(iso, sessionId, entry) {
  const sid = sessionId ? String(sessionId).slice(0, 8) : 'conductor';
  return `${iso} · ${sid} · ${entry}`;
}
