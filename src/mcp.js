import * as board from './board.js';

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

// Raw-text channel (additive to the pinned {result} contract, opt-in per call):
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
// Today only read_task opts in, and only when a plan body was actually read:
// the body leaves the JSON block; the plan METADATA (plan_path/plan_truncated/
// plan_missing) stays in it. `text` may also be a LIST of strings — one raw
// block each, in order — so moving further bodies (a card's goal/logbook,
// read_progress entries) off the JSON block is an extra key in RAW_BODY_KEYS
// plus its doc line, not a rewrite of this path.
const RAW_BODY_KEYS = { read_task: ['plan_body'] };

function shapeBody(tool, result) {
  const keys = RAW_BODY_KEYS[tool];
  if (keys && result?.ok === true) {
    const present = keys.filter((k) => typeof result[k] === 'string');
    if (present.length > 0) {
      const meta = { ...result };
      for (const k of present) delete meta[k];
      const text = present.map((k) => result[k]);
      return { meta, text: text.length === 1 ? text[0] : text };
    }
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
