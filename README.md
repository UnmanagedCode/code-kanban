# code-kanban

A [code-conductor](https://github.com/UnmanagedCode) plugin that gives the **conductor** a
persistent, file-backed **private kanban board**, exposed as MCP tools
(`mcp__code-conductor__code-kanban__*`). The board is the conductor's own tool — not a shared
team surface. Same extension pattern as the sibling plugins `code-hub` and `code-share`.

## What it does

- **Columns:** `triage → backlog → todo → in-progress → done` (`triage` is an intake inbox;
  no `review` column — review is a conductor process). One markdown file per card.
- **Duties:** the conductor is the sole reader/mutator; workers are pure emitters (`file_card`,
  `log_card`) that never handle a card id — `log_card` finds the card owned by the calling
  session server-side; `project` is optional on `log_card` and, if omitted, every project is
  scanned for the owned card. The conductor, which owns no card, may instead pass `log_card`
  an explicit `id` (+ required `project`) to target a specific in-progress or done card directly.
- **Epics:** first-class, per-state rollups computed on read; project-scoped **or** cross-project
  (spanning several projects with an aggregated rollup).
- **Web GUI:** a React board UI built on `npm install` (`frontend/dist`) is served at `/` (manifest
  `frontend.path`), in-process over the same `board.js` service layer. It follows
  code-conductor's light/dark theme when embedded and the OS theme standalone.
- **Cross-instance sync:** a **Sync** button pulls another instance's board (over a
  code-hub-forwarded URL) and merges it in, union + card-level last-edit-wins. Two-click, one-way
  per click. See [docs/architecture.md](docs/architecture.md) "Cross-instance sync".

See [docs/features.md](docs/features.md) for the full tool table.

## Architecture (quick)

Out-of-process HTTP server the conductor spawns via `npm start`. All board logic lives in one
service layer, `src/board.js` (the single source of truth and the GUI integration seam), guarded
by a per-project async mutex — the sole write path. Thin surfaces sit on top: `src/mcp.js`
(MCP tool dispatch) and the web GUI's HTTP routes (`src/routes.js`, in-process).

```
server.js                 Express: /api routes + the built UI, CSP on every response, listens on $PORT
conductor.plugin.json     plugin manifest (id: code-kanban)
src/
  board.js                ★ service layer / single source of truth / GUI seam
  store.js                file store (atomic fs, no git), id sequence, epics
  cardfile.js             card markdown <-> object
  paths.js projects.js mutex.js mcp.js routes.js
frontend/                 web GUI source (React + Vite + Tailwind); built to frontend/dist
docs/{features,protocol,architecture}.md
tests/                    node:test suites (run.mjs)
harness/playwright/       visual-verification wrapper over ../code-playwright
.wiki/                    durable gotchas + decisions
```

Board **data** lives in the conductor's tree, not here:
`<PROJECTS_ROOT>/.conduct/kanban/projects/<project>/{triage,backlog,todo,in-progress,done}/`.

## Key defaults

- Resolves `PROJECTS_ROOT` from the injected env (falls back to the repo's parent dir).
- Standalone port `7100` on `127.0.0.1` (the conductor injects `$PORT` in a supervised run).
- Node `>=22.18`.
- Card ids: `${year}-${NNNN}`, project-wide monotonic (no per-year reset).
- Card priority: `CRITICAL | HIGH | MEDIUM | LOW`, or **unset** when omitted — there is no default,
  since unset means "nobody has judged this yet". Set it at filing time via `file_card`. Listings
  sort column → priority (CRITICAL first, unset last) → newest id first.
- Result convention: `{ok:true,…}` / `{ok:false, code, reason}` inside the host's `{result}`
  envelope; refusals are returned, never thrown. Codes: `PROJECT_UNKNOWN`, `CARD_UNKNOWN`,
  `EPIC_UNKNOWN`, `INVALID_STATE`. See [docs/protocol.md](docs/protocol.md).

## Run / test

```bash
npm install        # also builds the UI into frontend/dist (the `prepare` script)
npm start          # standalone on http://127.0.0.1:7100
npm test           # node:test suites
npm run typecheck  # tsc over frontend/
npm run dev        # Vite dev server, API proxied to a running `npm start`
```

Under code-conductor: ship `conductor.plugin.json` at the repo root, enable the plugin; the host
spawns `npm start` and forwards MCP calls to `/api/mcp`.

## Known limitations

- `npm install` under `NODE_ENV=production` or `npm_config_omit=dev` skips the devDependencies, so
  the UI is not built and the page answers 503 until a full `npm install`.
- Setting `HOST` to a non-loopback address exposes the API, which has no authentication, to the
  network.
- Single-writer design assumes the GUI runs **in this process**; a cross-process GUI would need
  an HTTP board API first (see `.wiki/architecture/service-layer-seam.md`).
- No git writes to `.conduct` by design — board snapshotting is the conductor's job.

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
© 2026 UnmanagedCode. See [LICENSE](LICENSE) for details.
