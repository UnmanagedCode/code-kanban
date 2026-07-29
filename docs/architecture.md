# Architecture — internals

## Process model

An out-of-process HTTP server the conductor spawns via `npm start` (`server.js`), listening on
the injected `PORT`. It reaches the host only through injected env vars and the per-call MCP
envelope — it **never imports host modules** (they run in a different process).

Env this plugin reads: `PORT`, `HOST` (`server.js`), `PROJECTS_ROOT` (`src/paths.js`),
`CONDUCTOR_URL` (project validation, `src/projects.js`). The host also injects
`CONDUCTOR_PROJECT_DIR` and `CONDUCTOR_PLUGIN_ID`, which this plugin does not currently use.

## Components

| Module | Responsibility |
|--------|----------------|
| `src/board.js` | **Single source of truth** — all board logic (transitions, id assignment, validation, log stamping, refusal codes). The GUI seam. Exports `ALLOWED_TRANSITIONS` read-only for the GUI's legal-move rendering. |
| `src/store.js` | File store: state dirs, atomic writes, moves, id sequence, epic files. **No git.** |
| `src/taskfile.js` | Task markdown ⇄ object (frontmatter + Goal/Acceptance/Logbook). |
| `src/paths.js` | Resolve `PROJECTS_ROOT` → `.conduct/kanban/...` paths. Ordered `STATES`. |
| `src/projects.js` | `validateProject` — shape check + live list via `CONDUCTOR_URL/api/projects` (scan fallback standalone). `listProjects` — same source, for the GUI selector. |
| `src/mutex.js` | Per-project async mutex — the one serialized write path. |
| `src/mcp.js` | Thin tool dispatch → `board.js`; MCP envelope. |
| `src/routes.js` / `server.js` | Express `/api/health` + `/api/mcp` + the GUI's `/api/projects`, `/api/board/*` routes; `express.static(frontend/)` serves the GUI at `/`. Listen wiring. |

Thin surfaces (`mcp.js`, the GUI routes) call `board.js`; they never duplicate logic or call each
other. The GUI's additions to `board.js`/`projects.js` are **export-only** — `ALLOWED_TRANSITIONS`
and `listProjects` are read out; no service-layer logic changed.

## On-disk state

Board DATA lives in the conductor's tree, not this repo:

```
<PROJECTS_ROOT>/.conduct/kanban/
  epics/<slug>.md                              # CROSS-project epic: frontmatter projects:[…]
  projects/<project>/
    triage/ backlog/ todo/ in-progress/ done/  # one <id>.md per task
    epics/<slug>.md                            # project-scoped epic; goal only
```

- **No git writes from the plugin** (decision — see `.wiki/architecture/file-store-layout.md`).
  Moves are plain fs (write new dir + unlink old); writes are tmp-file + `rename` (atomic).
  Per-card history lives in the Logbook; git snapshotting of `.conduct` is the conductor's job.
- **IDs**: `${year}-${NNNN}`, where `NNNN` is a project-wide monotonic sequence
  (`max existing + 1`, does **not** reset on year rollover). Assigned inside the project mutex.
- **Epic rollups** are never stored — recomputed by scanning tasks on each read. A cross-project
  epic aggregates the scan across every project in its frontmatter `projects:[…]` list.
- **Cross-project epics** live in the top-level `epics/` dir (above `projects/`) and join tasks by
  the same `epic:<slug>` field. A slug can't be both a cross-project epic and a per-project epic in
  one of its members (`createEpic` refuses `EPIC_CONFLICT` in both orders), so a task's epic slug is
  unambiguous. Their writes serialize on a dedicated `withLock(' cross-epics')` key — distinct from
  every project name — so the per-project single-writer invariant is untouched.

## Cross-instance sync

Sync one board with another instance on a different machine, reachable at a code-hub-forwarded
URL (no git). **Two-click, one-way pull per click**: each click pulls the peer's FULL board dump
for a scope and merges it in; converging both machines means clicking Sync on each side. The merge
itself is grow-only: it unions by `uid` and never deletes a card it doesn't recognize. `delete_task`
(a plain hard delete, not a sync-aware tombstone) is a real gap this leaves: a task deleted on one
machine can reappear the next time that machine pulls from a peer that still holds it. Accepted for
now (YAGNI — no caller needs cross-machine delete propagation); revisit if that changes. Details +
rationale: `.wiki/architecture/cross-instance-sync.md`.

- **Hidden identity.** Cards carry three sync-only frontmatter fields (`src/taskfile.js`):
  `uid` (the true match key — random `crypto.randomUUID` for new cards), `updated` (UTC ISO-8601
  version stamp, bumped by **every** mutator via `board.js`'s `touch()`), and `node` (the machine
  that wrote this version — the LWW tiebreak). `uid`/`node` are stripped from every MCP/GUI read
  (`board.readTask`'s `stripHidden`; `summary()` never included them); `GET /api/sync/export` is
  the sole exposure. The short `${year}-${NNNN}` display id stays the MCP handle and never grows.
- **Node id**: a per-machine id minted once at `<kanbanRoot>/.node-id` (`src/nodeId.js`).
- **Merge** (`board.syncPull` → `mergeProject`, inside the same per-project `withLock`): union by
  `uid`. New peer uid → copied in, keeping its display id if free, else **reassigned** the next
  free local id (`uid` untouched — solves two machines minting the same `2026-NNNN` for different
  cards). Same uid on both → whole-card **last-edit-wins** (later `updated`, tiebreak higher
  `node`), keeping the local display id. `depends_on` (display-id sugar) is translated
  remote-id → uid → local-id from the pulled set; unresolvable entries are dropped and reported.
- **Migration**: legacy cards (no `uid`) are backfilled lazily at export/pull time under the lock.
  `uid` is **deterministic** — `deriveUid(project, id, created)` — so two machines holding the
  same shared-lineage legacy card derive the identical uid and union instead of duplicating.
- **Epics sync too** (`exportBoard` carries `projectEpics`/`crossEpics`; `syncPull` merges them
  BEFORE cards, so a card's `epic:` resolves against fresh epics). Epics match by **slug** (project
  epic keyed by `(project,slug)`, cross by `slug`) — NOT uid: the slug is human-chosen, addressable
  identity that cards reference, so it is never reassigned and `card.epic` is kept verbatim (never
  translated, and can never mispoint). Union by slug + whole-epic last-edit-wins (`updated`, tiebreak
  `node`; no uid). Legacy epics get `updated = created` backfilled so shared slugs match. A
  **kind conflict** (a slug that is a project epic on one side, cross-project on the other — the
  state `createEpic`'s `EPIC_CONFLICT` guard forbids) is **skipped and logged** in
  `summary.epicConflicts`, never merged and never deleted (grow-only). Cross epics merge under
  `CROSS_LOCK`, project epics under the project lock. A single-project export carries the project's
  own epics plus every cross epic covering it — exactly the set its cards can reference. `updated`/
  `node` are hidden from `read_epic`/`list_epics` (their responses are built from a field whitelist);
  `/api/sync/export` is the sole exposure.
- **Scope**: `project` (the current project) or `all` (every live project from `listProjects`).
  A peer project not present locally is skipped and reported (never auto-created).
- **Trust**: no auth — possession of the code-hub URL is the capability (the whole board API is
  already exposed by forwarding). The pull runs backend-to-backend to dodge browser CORS; the
  dialog shows THIS board's URL from `window.location` (the backend can't know its forwarded URL).

## GUI integration seam

The web GUI runs **in this process**. `server.js` mounts the API router at `/api` first, then
`express.static(frontend/)` to serve the zero-build vanilla-ESM GUI at the manifest's
`frontend.path` (`/`) — API first so `/api/*` is never shadowed by a static file. The GUI's
`/api/board/*` routes (in `src/routes.js`) are a thin 1:1 delegate to `board.js`: each calls the
matching function and passes its `{ok}` envelope through as the HTTP body, so GUI requests and
MCP-tool calls serialize on the **same** in-process mutex — one writer. `board.js`'s function
interface (the `{ok}` / `{ok:false,code,reason}` return contract) remains the documented seam.

GUI mutations are attributed to the constant `GUI_ACTOR = 'gui'` (`src/routes.js`) — the GUI has
no human identity, so `'gui'` is the honest logbook actor. `board.js` clears `owner` on any
non-`in-progress` move regardless, so passing `GUI_ACTOR` on every move only stamps the move's
log line (and in-progress ownership); it never leaves a stuck owner.

**Serving scope.** The harness verifies the GUI at the plugin root (`/`). The host-mounted case
— the conductor serving the plugin under a sub-path — is reasoned correct (the GUI uses
relative `api/...` URLs and the manifest's `frontend.path`, and `express.static` is path-agnostic)
but is **not** harness-verified; if the host mounts under a prefix, confirm the static + API
prefixes line up before relying on it.

## Test patterns

`node:test` via `tests/run.mjs` (`npm test`). Each test isolates state in a fresh
`mkdtemp` set as `PROJECTS_ROOT` (`tests/_helpers.mjs`) and injects the live-project list via
`projects._setProjectFetcher` — no network, deterministic, order-independent.
