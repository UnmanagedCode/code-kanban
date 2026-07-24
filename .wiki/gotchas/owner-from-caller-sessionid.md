# Gotcha: `log_progress` resolves the card from the session, not an id — except for the conductor

Workers are pure emitters and never handle a task id. `log_progress({project?, entry})` finds its
target **server-side**: the `in-progress` card whose `owner === caller.sessionId`. `project` is
optional — supplied, it scopes the lookup directly (fast path); omitted, every project is scanned.
The `owner` is stamped by `move_task(..., to:"in-progress", owner:<sessionId>)` — the conductor
sets it when it hands the card to the worker.

The conductor owns no card, so it can't use that path. `log_progress({project, id, entry})` gives
it a second, id-based path: `id` targets that exact card directly, **bypassing** the owner check
entirely. Because ids are per-project (not globally unique), `project` becomes **required** when
`id` is given → `INVALID_STATE` if missing. The card must be `in-progress` (in-progress-only, by
decision) — nonexistent or any other state → `TASK_UNKNOWN`. The id-path re-verifies the card is
still present + `in-progress` inside the project's `withLock` before writing, same shape as the
worker path's re-verify. Attribution reuses `taskfile.logLine`'s existing convention (sessionId
`null`/absent → `'conductor'`) — the same one `move_task` already uses for its own logbook lines
— rather than inventing a new actor label.

Resolution rules (`board.logProgress`, worker/session path — unaffected by the id path):
- No `sessionId` (host couldn't resolve the caller) → `{ok:false, code:"TASK_UNKNOWN"}`.
- No `in-progress` card owned by that session (in the given project, or anywhere when scanning) →
  `TASK_UNKNOWN`.
- **More than one** owned `in-progress` card → resolve to the **most recently modified** one
  (by file mtime), across projects too when `project` was omitted. Chosen over refusing so a
  worker's log never gets dropped; a session normally owns exactly one active card, so this
  tie-break is a rare safety net.

**Cross-project scan locking:** `withLock` (`src/mutex.js`) is a per-project, in-process key —
never nested, no cross-project variant. So the scan-for-owning-project step (`resolveOwningProject`
in `board.js`) runs **unlocked** across all of `listProjects()` (same as any other read in
`board.js` — reads never take the mutex), then `logProgress` takes `withLock` on only the winning
project and **redoes the owned-card lookup inside the lock** before writing. If the card
disappeared or changed owner between the scan and the lock (rare), that re-check returns
`TASK_UNKNOWN` rather than falling back to re-scan other projects — the write itself stays
race-free per project, exactly like every other mutator (see
`.wiki/architecture/service-layer-seam.md`).

`caller.sessionId` arrives in the MCP envelope (`{tool, arguments, caller:{sessionId, project}}`)
and is threaded through `src/mcp.js`. It is the only path by which a worker's log reaches a card.
