# Cross-instance board sync

How one board syncs with another instance on a different machine (task
code-kanban/2026-0005). Transport is a code-hub-forwarded URL — no git.

## Model
- **Two-click, one-way pull per click.** A click pulls the peer's FULL board dump for a scope
  and merges it locally. Converging both machines = clicking Sync on each side. There is no
  push/bidirectional exchange.
- **Grow-only merge.** `delete_task` exists (a plain hard delete) but is NOT sync-integrated — no
  tombstone concept, so the merge itself is still a pure union + overwrite. Consequence: a task
  deleted locally can reappear on a future pull from a peer that still holds it. See
  `docs/architecture.md` "Cross-instance sync" for the accepted-tradeoff rationale.

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
- **SSRF guard.** Because the server fetches a user-supplied URL, `peerUrl` pointing at a
  loopback/private/link-local IP literal (incl. the `169.254.169.254` metadata IP) is refused, the
  fetch does not follow redirects, and it is bounded by a timeout + size cap (`board.js`
  `isBlockedSyncHost`, `defaultSyncFetch`). Lightweight only — hostnames are NOT DNS-resolved (a
  code-hub peer is public), so DNS-rebinding-style targets aren't caught; hardening the whole plugin
  is the separate future task. `CODE_KANBAN_SYNC_ALLOW_PRIVATE=1` bypasses the host block for local
  dev / the visual harness (both instances run on 127.0.0.1).

## The pull summary is GUI-facing — display ids only
`syncPull` returns a `summary` that `routes.js` passes to `app.js`. It must carry **no `uid`/`node`**
(same invariant as reads). So `reassigned` uses `{from,to}` display ids, `droppedDeps` reports the
dependent card by its remote **display** id, and malformed peer cards (missing/non-string `id` or an
unknown column) are skipped into `skippedCards` by display id. Epic-merge adds `epicsAdded`/
`epicsUpdated` counts, `epicConflicts[]` and `skippedEpics[]` — all **slugs/counts only**, no
`updated`/`node`. GOTCHA: if you add a field to the summary, don't put a `uid`/`node`/timestamp in
it. `tests/sync.test.mjs` scans the whole serialized summary to enforce this.

## Epics sync too — slug is identity (NOT uid)
This is the key divergence from the card model, and it's deliberate. Cards use a random `uid`
because their numeric ids auto-mint and a collision means DIFFERENT cards. **Epics match by slug**
(project epic keyed by `(project,slug)`, cross epic by `slug`) because the slug is human-chosen,
addressable identity that cards reference via `epic:`. Consequences:
- **No `uid` on epics.** They carry only `updated` (LWW clock, bumped by `createEpic` — the sole
  epic mutator) and `node` (tiebreak). Both hand-rolled serializers in `store.js` (`writeEpic`,
  `writeCrossEpic`) emit them; both parsers read them. Legacy epics get `updated = created`
  backfilled deterministically so shared slugs match.
- **Slugs are never reassigned, so `card.epic` is never translated** — it's kept verbatim and can
  never mispoint (contrast `depends_on`, which IS translated because display ids get reassigned).
  A dangling `card.epic` (slug present nowhere) is kept verbatim too — safe, just uncounted.
- **Union by slug + whole-epic LWW** (later `updated`, tiebreak higher `node`). Same-slug/
  different-content epics LWW-merge (loser's title/goal lost) — usually they're the same epic humans
  named identically anyway.
- **Merge order:** epics BEFORE cards, so a card's `epic:` resolves against fresh epics. Cross epics
  merge under `CROSS_LOCK` first; then per project, project epics then cards under `withLock(P)`.
- **Kind conflict** (a slug that is a project epic on one side, cross-project on the other — the
  state `createEpic`'s `EPIC_CONFLICT` guard forbids): **skip + log** in `summary.epicConflicts`,
  never merge the second representation, never delete (grow-only). Because the cross phase runs
  first, an intra-dump kind flip (same slug appearing as both cross and project in ONE dump)
  resolves deterministically: cross is written first, the project version then hits the guard and is
  skipped+logged.
- **Single-project scope** carries the project's own epics PLUS every cross epic covering it —
  exactly the set a card in that project can reference (`epicVisibleIn`), so every `card.epic`
  resolves without a drop-and-log rule.
- **Hidden-field discipline:** `board.readEpic`/`listEpics` build responses from a field whitelist
  (`{slug,title,goal,rollup,projects}`), so `updated`/`node` never leak; `/api/sync/export` is the
  sole exposure. Same as cards.

## Scope & limitations
- `project` = the current project; `all` = every live project (`listProjects`). A peer project
  absent locally is **skipped and reported**, never auto-created (the conductor owns the catalog).
- `owner`/`commit` ride along on a whole-card replace (they're just frontmatter) — a synced
  in-progress card may carry the peer's session/worktree references. Acceptable under whole-card LWW.

## Invariant compliance
Every merge write goes through `store` under the same per-project `withLock` as any other mutator —
the single-writer invariant (see [../overview.md](../overview.md)) is preserved. The mutex is
in-process only; it does not guard against the peer machine writing its own files (it doesn't — the
pull only reads the peer via HTTP).
