# Architecture — internals

## Process model

An out-of-process HTTP server the conductor spawns via `npm start` (`server.js`), listening on
the injected `PORT`. It reaches the host only through injected env vars and the per-call MCP
envelope — it **never imports host modules** (they run in a different process).

Injected env: `PORT`, `PROJECTS_ROOT`, `CONDUCTOR_URL`, `CONDUCTOR_PROJECT_DIR`,
`CONDUCTOR_PLUGIN_ID`.

## Components

| Module | Responsibility |
|--------|----------------|
| `src/board.js` | **Single source of truth** — all board logic (transitions, id assignment, validation, log stamping, refusal codes). The GUI seam. |
| `src/store.js` | File store: state dirs, atomic writes, moves, id sequence, epic files. **No git.** |
| `src/taskfile.js` | Task markdown ⇄ object (frontmatter + Goal/Acceptance/Logbook). |
| `src/paths.js` | Resolve `PROJECTS_ROOT` → `.conduct/kanban/...` paths. Ordered `STATES`. |
| `src/projects.js` | `validateProject` — shape check + live list via `CONDUCTOR_URL/api/projects` (scan fallback standalone). |
| `src/mutex.js` | Per-project async mutex — the one serialized write path. |
| `src/mcp.js` | Thin tool dispatch → `board.js`; MCP envelope. |
| `src/routes.js` / `server.js` | Express `/api/health` + `/api/mcp`; listen wiring. |

Thin surfaces (`mcp.js`, later the GUI routes) call `board.js`; they never duplicate logic or
call each other.

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

The future web GUI runs **in this process** and imports `board.js` directly; all its mutations
go through the same per-project mutex, keeping a single writer. `board.js`'s function
interface — not an HTTP contract — is the documented seam. A cross-process GUI would instead
need an HTTP board API over `board.js` (deferred; noted in the wiki).

## Test patterns

`node:test` via `tests/run.mjs` (`npm test`). Each test isolates state in a fresh
`mkdtemp` set as `PROJECTS_ROOT` (`tests/_helpers.mjs`) and injects the live-project list via
`projects._setProjectFetcher` — no network, deterministic, order-independent.
