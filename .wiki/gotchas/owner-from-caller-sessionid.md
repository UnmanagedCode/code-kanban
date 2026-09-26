# Gotcha: `log_card` resolves the card from the session, not an id — except for the conductor

Workers are pure emitters and never handle a card id. `log_card({project?, entry})` finds its
target **server-side**: the `in-progress` card whose `owner === caller.sessionId`. `project` is
optional — supplied, it scopes the lookup directly (fast path); omitted, every project is scanned.
The `owner` is stamped by `move_card(..., to:"in-progress", owner:<sessionId>)` — the conductor
sets it when it hands the card to the worker.

The conductor owns no card, so it can't use that path. `log_card({project, id, entry})` gives
it a second, id-based path: `id` targets that exact card directly, **bypassing** the owner check
entirely. Because ids are per-project (not globally unique), `project` becomes **required** when
`id` is given → `INVALID_STATE` if missing. The card's lane must be in `LOGGABLE_STATES`
(`in-progress` or `done`, in `src/board.js`): `done` is loggable so a landing note can follow
`move_card(to:'done')`, and the write goes to the card's own lane (it stays `done`). The pre-start
lanes (triage/backlog/todo) are refused because a logbook records work on a card and they have
none. Codes: nonexistent → `CARD_UNKNOWN` (`unknown card: <id>`); a wrong lane → `INVALID_STATE`
naming `LOGGABLE_STATES` — matching `move_card` and `update_card`'s `owner`, where a wrong lane is
also `INVALID_STATE`, so `CARD_UNKNOWN` means only "no such card" on this path. The lookup and lane
check both run inside the project's `withLock`, same shape as the worker path's re-verify. Attribution reuses `cardfile.logLine`'s existing convention (sessionId
`null`/absent → `'conductor'`) — the same one `move_card` already uses for its own logbook lines
— rather than inventing a new actor label.

Resolution rules (`board.logCard`, worker/session path — unaffected by the id path):
- No `sessionId` (host couldn't resolve the caller) → `{ok:false, code:"CARD_UNKNOWN"}`.
- No `in-progress` card owned by that session (in the given project, or anywhere when scanning) →
  `CARD_UNKNOWN` with the `NO_OWNED_CARD` reason (says the id-less form targets only an owned
  in-progress card and that a conductor uses `id` + `project`; it does not invite a worker to pass
  `id` — workers stay off the board, see `docs/features.md` "Duties").
- **The id-less form never resolves a `done` card — by decision.** `moveCard` sets `owner = null`
  on every exit from `in-progress` and `update_card` refuses `owner` outside it, so a done card has
  no owner to match. Resolving one would need a new persisted "last owner" field plus a tie-break
  across every card the session ever landed — an inferred target the strict-params rule forbids.
  Landing is the conductor's act, and the conductor already has the `id` form.
- **More than one** owned `in-progress` card → resolve to the **most recently modified** one
  (by file mtime), across projects too when `project` was omitted. Chosen over refusing so a
  worker's log never gets dropped; a session normally owns exactly one active card, so this
  tie-break is a rare safety net.

**Cross-project scan locking:** `withLock` (`src/mutex.js`) is a per-project, in-process key —
never nested, no cross-project variant. So the scan-for-owning-project step (`resolveOwningProject`
in `board.js`) runs **unlocked** across all of `listProjects()` (same as any other read in
`board.js` — reads never take the mutex), then `logCard` takes `withLock` on only the winning
project and **redoes the owned-card lookup inside the lock** before writing. If the card
disappeared or changed owner between the scan and the lock (rare), that re-check returns
`CARD_UNKNOWN` rather than falling back to re-scan other projects — the write itself stays
race-free per project, exactly like every other mutator (see
`.wiki/architecture/service-layer-seam.md`).

`caller.sessionId` arrives in the MCP envelope (`{tool, arguments, caller:{sessionId, project}}`)
and is threaded through `src/mcp.js`. It is the only path by which a worker's log reaches a card.
