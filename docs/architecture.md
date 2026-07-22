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
<PROJECTS_ROOT>/.conduct/kanban/projects/<project>/
  triage/ backlog/ todo/ in-progress/ done/   # one <id>.md per task
  epics/<slug>.md                              # goal only; rollup computed on read
```

- **No git writes from the plugin** (decision — see `.wiki/architecture/file-store-layout.md`).
  Moves are plain fs (write new dir + unlink old); writes are tmp-file + `rename` (atomic).
  Per-card history lives in the Logbook; git snapshotting of `.conduct` is the conductor's job.
- **IDs**: `${year}-${NNNN}`, where `NNNN` is a project-wide monotonic sequence
  (`max existing + 1`, does **not** reset on year rollover). Assigned inside the project mutex.
- **Epic rollups** are never stored — recomputed by scanning tasks on each read.

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
