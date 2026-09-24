# Decision: epic order is active-first, then last activity (list_epics)

Every GUI epic surface (rollup pane, both epic `<select>`s in `frontend/app.js`) and MCP
`list_epics` read one list, `board.listEpics` — so the order is set once there, by
`compareEpics` in `src/board.js`. Before this, order was `readdirSync` (hash order on ext4) with
cross epics appended.

## The key
`completed` (active first) → `lastActivity` DESC → `slug` ascending by code units (`<`, not
`localeCompare`: no locale dependence). Total within one result: a slug is unique there
(`EPIC_CONFLICT` + sync's kind-conflict skip).

## Why last activity, not the epic's own `updated`
An epic record rarely changes after creation (`createEpic` re-posts and `logEpic` only); the work
lands on its cards, and every card mutator already bumps `card.updated` via `touch()`. So
`lastActivity = max(epic.updated ?? created, member cards' updated ?? created)` over every project
the epic spans. Near-free: `listEpics` already walks those cards for the rollup.

## Why NOT file mtime (refuted)
- `syncPull` writes a peer's OLDER version with a FRESH local mtime.
- `backfillProjectEpics` / any copy, clone or checkout resets it.
- It ignores card activity anyway.
`updated` exists precisely because mtime can't be trusted across instances; the sync test
"listEpics after a pull orders by synced stamp, not by write time" pins this.

## Gotchas
- **Fallback, no migration.** `updated` can be null at read time on a legacy epic (the sync
  backfill only runs on export/merge), so read `updated ?? created`. Missing or unparseable →
  `-Infinity`: sorts last in its group, never throws (a peer may send any string).
  A bare `updated:` line would read as `''` (not nullish) and skip the fallback, so
  `parseEpicFile` (`src/store.js`) coerces empty `created`/`updated` to `null`, as `cardfile.parse` does.
- **Empty ≠ completed.** `completed = total > 0 && done === total`, derived from the same
  `countStates` rollup — an epic with zero cards stays active.
- **`lastActivity` is not in the response.** It's a hidden-stamp derivative; the listEpics entry
  is a whitelist `{slug,title,rollup,projects,completed}` (pinned in `tests/sync.test.mjs`).
- **Blind spots (accepted):** deleting a card, or re-pointing it from epic A to B, does not bump A
  (no stamp moves on A's side).
- **GUI never recomputes `completed`** — it splits on the server flag. No toggle, no collapsible
  group (YAGNI; the completed group sits at the bottom of the 25vh pane).
