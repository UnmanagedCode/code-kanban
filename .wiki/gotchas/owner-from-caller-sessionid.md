# Gotcha: `append_log` resolves the card from the session, not an id

Workers are pure emitters and never handle a task id. `append_log({project, entry})` finds its
target **server-side**: the `in-progress` card in `project` whose `owner === caller.sessionId`.
The `owner` is stamped by `move_task(..., to:"in-progress", owner:<sessionId>)` — the conductor
sets it when it hands the card to the worker.

Resolution rules (`board.appendLog`):
- No `sessionId` (host couldn't resolve the caller) → `{ok:false, code:"TASK_UNKNOWN"}`.
- No `in-progress` card owned by that session → `TASK_UNKNOWN`.
- **More than one** owned `in-progress` card → resolve to the **most recently modified** one
  (by file mtime). Chosen over refusing so a worker's log never gets dropped; a session normally
  owns exactly one active card, so this tie-break is a rare safety net.

`caller.sessionId` arrives in the MCP envelope (`{tool, arguments, caller:{sessionId, project}}`)
and is threaded through `src/mcp.js`. It is the only path by which a worker's log reaches a card.
