# code-kanban

A [code-conductor](https://github.com/UnmanagedCode) plugin that gives the **conductor** a
persistent, file-backed **private task board**, exposed as MCP tools
(`mcp__code-conductor__code-kanban__*`). The board is the conductor's own tool — not a shared
team surface. Same extension pattern as the sibling plugins `code-hub` and `code-share`.

## What it does

- **Columns:** `triage → backlog → todo → in-progress → done` (`triage` is an intake inbox;
  no `review` column — review is a conductor process). One markdown file per task.
- **Duties:** the conductor is the sole reader/mutator; workers are pure emitters (`file_task`,
  `log_progress`) that never handle a task id — `log_progress` finds the card owned by the calling
  session server-side.
- **Epics:** project-scoped, first-class, with per-state rollups computed on read.
- **Web GUI:** a local zero-build board UI is served at `/` (manifest `frontend.path`), in-process
  over the same `board.js` service layer.

See [docs/features.md](docs/features.md) for the full tool table.

## Architecture (quick)

Out-of-process HTTP server the conductor spawns via `npm start`. All board logic lives in one
service layer, `src/board.js` (the single source of truth and the GUI integration seam), guarded
by a per-project async mutex — the sole write path. Thin surfaces sit on top: `src/mcp.js`
(MCP tool dispatch) and, later, the web GUI (in-process, importing `board.js` directly).

```
server.js                 Express: /api/health + /api/mcp, listens on $PORT
conductor.plugin.json     plugin manifest (id: code-kanban)
src/
  board.js                ★ service layer / single source of truth / GUI seam
  store.js                file store (atomic fs, no git), id sequence, epics
  taskfile.js             task markdown <-> object
  paths.js projects.js mutex.js mcp.js routes.js
docs/{features,protocol,architecture}.md
tests/                    node:test suites (run.mjs)
harness/playwright/       visual-verification wrapper over ../code-playwright
.wiki/                    durable gotchas + decisions
```

Board **data** lives in the conductor's tree, not here:
`<PROJECTS_ROOT>/.conduct/kanban/projects/<project>/{triage,backlog,todo,in-progress,done}/`.

## Key defaults

- Resolves `PROJECTS_ROOT` from the injected env (falls back to the repo's parent dir).
- Standalone port `7100` (the conductor injects `$PORT` in a supervised run).
- Task ids: `${year}-${NNNN}`, project-wide monotonic (no per-year reset).
- Result convention: `{ok:true,…}` / `{ok:false, code, reason}` inside the host's `{result}`
  envelope; refusals are returned, never thrown. Codes: `PROJECT_UNKNOWN`, `TASK_UNKNOWN`,
  `EPIC_UNKNOWN`, `INVALID_STATE`. See [docs/protocol.md](docs/protocol.md).

## Run / test

```bash
npm install
npm start          # standalone on http://127.0.0.1:7100
npm test           # node:test suites
```

Under code-conductor: ship `conductor.plugin.json` at the repo root, enable the plugin; the host
spawns `npm start` and forwards MCP calls to `/api/mcp`.

## Known limitations

- The web GUI is served at the plugin root (`/`); the host-mounted / sub-path serving case is
  reasoned but not harness-verified (see `docs/architecture.md`).
- Single-writer design assumes the GUI runs **in this process**; a cross-process GUI would need
  an HTTP board API first (see `.wiki/architecture/service-layer-seam.md`).
- No git writes to `.conduct` by design — board snapshotting is the conductor's job.
