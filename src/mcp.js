import * as board from './board.js';
import { serializeBody } from './taskfile.js';

// Thin dispatch over board.js. Domain refusals from the service layer are
// {ok:false, code, reason} objects returned as the {result} payload (a normal
// MCP outcome the conductor relays to the model) — they are NOT {error}. Only a
// malformed envelope (missing/unknown tool) or an unexpected exception maps to
// {error}. Owner-scoped tools receive the caller's server-resolved sessionId.
const handlers = {
  file_task:   (a, sid) => board.fileTask({ ...a, sessionId: sid }),
  log_progress: (a, sid) => board.logProgress({ project: a.project, id: a.id, entry: a.entry, sessionId: sid }),
  list_tasks:  (a) => board.listTasks(a),
  read_task:   (a) => board.readTask(a),
  read_progress: (a) => board.readProgress(a),
  move_task:   (a) => board.moveTask(a),
  update_task: (a) => board.updateTask(a),
  delete_task: (a) => board.deleteTask(a),
  create_epic: (a) => board.createEpic(a),
  list_epics:  (a) => board.listEpics(a),
  read_epic:   (a) => board.readEpic(a),
};

// Raw-text channel (additive to the pinned {result} contract, opt-in per tool):
// a success body of {meta, text} makes the HOST emit `meta` as one compact-JSON
// block plus each `text` as a RAW, UNESCAPED content block after it — instead of
// JSON-escaping a multi-KB document into a single line. See code-conductor
// `src/plugins/mcpBridge.ts` (the `rec.text !== undefined` branch) and
// `src/mcp/content.ts`'s `textPayload`.
//
// The split lives HERE, not in board.js: board.js stays the single source of
// truth returning one structured object, which the GUI's 1:1 HTTP routes need
// as JSON. Only this MCP surface renders raw blocks.
//
// Which fields become raw blocks is decided by ONE rule, stated in
// docs/protocol.md: a field is a text block when it is authored prose or a
// markdown document (read top-to-bottom); everything a caller BRANCHES on —
// scalars, ids, counts, flags, arrays of record summaries — stays in the single
// compact-JSON metadata block. A list of summaries is data even though it
// contains titles, so list_tasks/list_epics stay pure {result}.
//
// Per tool, an ORDERED list of extractors: each takes (result, meta) -> the
// body string or null, and removes from `meta` (a shallow clone of `result`)
// whatever it promoted. Order is wire order; `text` is always an array, so
// two-block reads (card body then plan body) are explicit and testable.
const RAW_TEXT = {
  read_task: [cardBody, promote('plan_body')],
  read_progress: [progressEntries],
  read_epic: [epicGoal],
};

// A body already sitting on the envelope as a string (2026-0009's plan_body).
function promote(key) {
  return (result, meta) => {
    if (typeof result[key] !== 'string') return null;
    delete meta[key];
    return result[key];
  };
}

// The card body is RE-RENDERED from the task object, not read off disk: the
// object is what logTail/stripHidden already shaped (board.readTask), so the
// text block always describes the same card the JSON block does.
function cardBody(result, meta) {
  if (!result.task) return null;
  const { goal, acceptance, logbook, ...rest } = result.task;
  meta.task = rest;
  return serializeBody(result.task);
}

// `entries` leaves the JSON block, which keeps `total` and gains `count` (how
// many came back after `limit` — otherwise unrecoverable). Same `- ` bullet
// rendering as the card body's ## Logbook.
function progressEntries(result, meta) {
  const entries = result.entries ?? [];
  meta.count = entries.length;
  delete meta.entries;
  return entries.map((e) => `- ${e}`).join('\n');
}

function epicGoal(result, meta) {
  if (!result.epic) return null;
  const { goal, ...rest } = result.epic;
  meta.epic = rest;
  return goal ?? '';
}

function shapeBody(tool, result) {
  const extractors = RAW_TEXT[tool];
  if (extractors && result?.ok === true) {
    const meta = { ...result };
    const text = [];
    for (const extract of extractors) {
      const body = extract(result, meta);
      if (body) text.push(body); // empty body -> no block at all
    }
    return { meta, text };
  }
  return { result: result === undefined ? null : result };
}

// Envelope-level problems (missing/invalid `tool`) -> 400. Everything else ->
// 200 with {result} (or {meta,text}) or {error}. Reserve non-200 for
// transport-level failures.
export async function handle(body) {
  const { tool, arguments: args, caller } = body || {};
  if (typeof tool !== 'string' || tool.length === 0) {
    return { status: 400, body: { error: 'tool is required and must be a non-empty string' } };
  }
  const fn = handlers[tool];
  if (!fn) return { status: 200, body: { error: `unknown tool: ${tool}` } };
  try {
    const result = await fn(args ?? {}, caller?.sessionId ?? null);
    return { status: 200, body: shapeBody(tool, result) };
  } catch (e) {
    return { status: 200, body: { error: e.message } };
  }
}
