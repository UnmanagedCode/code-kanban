import * as board from './board.js';

// Thin dispatch over board.js. Domain refusals from the service layer are
// {ok:false, code, reason} objects returned as the {result} payload (a normal
// MCP outcome the conductor relays to the model) — they are NOT {error}. Only a
// malformed envelope (missing/unknown tool) or an unexpected exception maps to
// {error}. Owner-scoped tools receive the caller's server-resolved sessionId.
const handlers = {
  file_task:   (a, sid) => board.fileTask({ ...a, sessionId: sid }),
  log_progress: (a, sid) => board.logProgress({ project: a.project, entry: a.entry, sessionId: sid }),
  list_tasks:  (a) => board.listTasks(a),
  read_task:   (a) => board.readTask(a),
  read_progress: (a) => board.readProgress(a),
  move_task:   (a) => board.moveTask(a),
  update_task: (a) => board.updateTask(a),
  create_epic: (a) => board.createEpic(a),
  list_epics:  (a) => board.listEpics(a),
  read_epic:   (a) => board.readEpic(a),
};

// Envelope-level problems (missing/invalid `tool`) -> 400. Everything else ->
// 200 with {result} or {error}. Reserve non-200 for transport-level failures.
export async function handle(body) {
  const { tool, arguments: args, caller } = body || {};
  if (typeof tool !== 'string' || tool.length === 0) {
    return { status: 400, body: { error: 'tool is required and must be a non-empty string' } };
  }
  const fn = handlers[tool];
  if (!fn) return { status: 200, body: { error: `unknown tool: ${tool}` } };
  try {
    const result = await fn(args ?? {}, caller?.sessionId ?? null);
    return { status: 200, body: { result: result === undefined ? null : result } };
  } catch (e) {
    return { status: 200, body: { error: e.message } };
  }
}
