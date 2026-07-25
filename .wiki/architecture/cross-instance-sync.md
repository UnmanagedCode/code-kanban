# Cross-instance board sync

How one board syncs with another instance on a different machine (task
code-kanban/2026-0005). Transport is a code-hub-forwarded URL — no git.

## Model
- **Two-click, one-way pull per click.** A click pulls the peer's FULL board dump for a scope
  and merges it locally. Converging both machines = clicking Sync on each side. There is no
  push/bidirectional exchange.
- **Grow-only.** No delete op exists, so no tombstones — the merge is a pure union + overwrite.

## The identity problem this solves
Display ids (`${year}-${NNNN}`) are minted **per-project, per-filesystem** (`store.nextId`), so
two machines independently mint the *same* `2026-0007` for *different* new cards. Display id is
therefore NOT identity. The fix: a hidden `uid` in frontmatter is the true match key; sync unions
by `uid`, and display ids are reassigned/translated at the sync boundary.

## Frontmatter version stamp (all hidden except from export)
- `uid` — the match key. New cards: `crypto.randomUUID()` (`board.fileTask`). Legacy cards
  (pre-feature, no uid): `deriveUid(project, id, created)` — **deterministic**, so two machines
  holding the same shared-lineage legacy card derive the identical uid and union instead of
  duplicating. This is the whole reason backfill is a hash and not a random id.
- `updated` — UTC ISO-8601, the LWW clock. **Bumped by every mutator** via `board.js`'s
  `touch()` (fileTask sets it = `created`). GOTCHA: an edit that fails to move `updated` is
  invisible to sync — if you add a new mutation path, call `touch()`.
- `node` — the machine that produced this version (`src/nodeId.js`, minted once at
  `<kanbanRoot>/.node-id`). Only used as the LWW tiebreak.

`uid`/`node` are stripped from every read (`board.readTask`'s `stripHidden`; `summary()` never
carried them). `GET /api/sync/export` is the ONE intentional exposure. Keep it that way — the
short display id must stay the MCP-facing handle.

## Merge (`board.mergeProject`, inside `withLock(project)`)
1. Backfill identity on all local cards (persisted) → index `localByUid`, `usedIds`.
2. Pass A — classify each incoming card by `uid`:
   - uid matches local → **last-edit-wins**: later `updated` wins; exact tie → higher `node`
     wins (deterministic: both machines hold both node ids). Winner keeps the **local** display id.
   - new uid → keep its display id if free, else **reassign** the next free local id. `uid` never
     changes. (Free ids are reserved before reassignments to minimise churn.)
3. Pass B — write winners wholesale (fields, goal, acceptance, logbook, uid, updated, node), with
   `depends_on` translated `remote display id → remote uid → local display id` from the pulled
   set. A state change moves the file (`store.moveTask`).

## depends_on translation rule (confirmed decision)
`depends_on` is display-id sugar over `uid`. Entries that don't resolve from the pulled set are
**dropped and reported** in the summary — NOT kept as a raw remote id (a raw id could later collide
with an unrelated local card after reassignment → a wrong dependency). In `all` scope every
referenced (same-project) card is present, so nothing drops; in `project` scope a dangling/out-of-set
dep drops.

## Trust / URL (confirmed decisions)
- **No auth.** Possession of the code-hub-forwarded URL is the capability — code-hub already exposes
  the *entire* board API (including mutating routes) at that URL, so a token on just the read export
  would harden nothing. Hardening the whole plugin is a separate future task.
- **Own URL is client-side.** The backend can't know its public forwarded URL (only
  `PORT/HOST/PROJECTS_ROOT/CONDUCTOR_URL` are injected). The GUI reached the board *through* that
  URL, so the dialog reads `window.location` for the copyable "this board's URL".
- **Pull is backend-to-backend.** `POST /api/sync/pull` fetches `<peerUrl>/api/sync/export` from the
  server, not the browser — a browser cross-origin fetch would hit CORS.

## Scope & limitations
- `project` = the current project; `all` = every live project (`listProjects`). A peer project
  absent locally is **skipped and reported**, never auto-created (the conductor owns the catalog).
- **Epics are not synced in v1.** A synced card keeps its `epic` slug verbatim; if no matching epic
  exists locally the card is fine, it just isn't counted in that epic's rollup.
- `owner`/`commit` ride along on a whole-card replace (they're just frontmatter) — a synced
  in-progress card may carry the peer's session/worktree references. Acceptable under whole-card LWW.

## Invariant compliance
Every merge write goes through `store` under the same per-project `withLock` as any other mutator —
the single-writer invariant (see [../overview.md](../overview.md)) is preserved. The mutex is
in-process only; it does not guard against the peer machine writing its own files (it doesn't — the
pull only reads the peer via HTTP).
