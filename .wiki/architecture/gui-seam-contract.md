# The web GUI seam contract

The in-process web GUI (`frontend/`, served at `/` by `express.static` in `server.js`) talks to
`board.js` over thin HTTP routes in `src/routes.js`. This page is the 1:1 map and the rules the
GUI relies on — the things a reader can't quickly re-derive by skimming the route file.

## Route → `board.js` map

| Route | `board.js` / helper | Notes |
|---|---|---|
| `GET /api/projects` | `projects.listProjects` | Catalog for the selector; same source `validateProject` uses. Not board state — does **not** take the project mutex. |
| `GET /api/board/meta` | `STATES` + `ALLOWED_TRANSITIONS` | Returns `{states, transitions:["from>to"]}`. The GUI's single source for legal move targets. |
| `GET /api/board/:project/tasks` | `listTasks` | `?state`/`?epic` filters. |
| `GET /api/board/:project/tasks/:id` | `readTask` | Full task: goal, acceptance, logbook. |
| `POST /api/board/:project/tasks` | `fileTask` | `sessionId: GUI_ACTOR`. Lands in `triage`. |
| `PATCH /api/board/:project/tasks/:id` | `updateTask` | Body **is** the `fields` object. |
| `POST /api/board/:project/tasks/:id/move` | `moveTask` | `owner: owner || GUI_ACTOR`. |
| `GET /api/board/:project/epics` | `listEpics` | With rollups. |
| `GET /api/board/:project/epics/:slug` | `readEpic` | Epic + its tasks. |
| `POST /api/board/:project/epics` | `createEpic` | **Upsert** — see below. |

## Envelope pass-through

Each route calls the `board.js` function and `res.json()`s its return **unchanged** — no
unwrapping, no remapping. So the `{ok}` domain convention travels literally as the HTTP body:

- success → 200 `{ok:true, …}`
- refusal → 200 `{ok:false, code, reason}` (a **normal** result, not an error)
- malformed JSON → 400 `{error:"invalid request body"}`; unexpected throw → 500 `{error}`

This mirrors the MCP bridge's envelope rule — see [[result-envelope-vs-ok-shape]]. The GUI client
(`frontend/app.js`) reads `data.ok === false` as a refusal and surfaces `data.reason` in the
status line rather than treating it as a thrown error.

## `GUI_ACTOR` and the owner rule

`GUI_ACTOR = 'gui'` (`src/routes.js`) is the logbook attribution for human GUI mutations — the
GUI has no session identity, so `'gui'` is the honest actor. The `move` route passes
`owner: owner || GUI_ACTOR`. The crucial invariant is in `board.js` `moveTask`:

```
task.owner = to === 'in-progress' ? (owner ?? null) : null;
```

`owner` is stored **only** on entering `in-progress` and cleared on every other move. So passing
`GUI_ACTOR` on every move affects only (a) the move's logbook line and (b) ownership when the
target is `in-progress` — it can never leave a stuck `gui` owner on a non-`in-progress` card. The
`move to a non-in-progress destination clears owner` test pins this. Related: [[owner-from-caller-sessionid]].

## Read-only logbook / acceptance

The GUI renders the Logbook and the Acceptance checklist as **read-only** — there is no route to
append a log line or toggle an acceptance item. `log_progress` stays worker/conductor-only (it
resolves the card from `caller.sessionId`, which the GUI cannot supply). Acceptance is set at
`file_task` time and not in `update_task`'s `UPDATABLE` set, so the PATCH route silently ignores
any `acceptance` key — the GUI doesn't send one.

## `createEpic` is an upsert, not create-or-refuse

`POST /api/board/:project/epics` calls `board.createEpic`, which **upserts**: an existing slug is
refreshed (title/goal overwritten) with `created` preserved; it never returns a "duplicate"
refusal. The tool name `create_epic` is a slight misnomer. The GUI's new-epic form says
"Create / refresh" and seeds this expectation.

## `meta` is the single source for legal moves

The GUI does not hardcode the transition table. `renderBoard`/`openDetail` call
`transitionsFrom(state)` over `state.meta.transitions` (from `/api/board/meta`), so a legal move
target list is always derived from `ALLOWED_TRANSITIONS` — the same Set `board.js` enforces. If
the transition table changes, the GUI's offered targets change with it; an `INVALID_STATE`
refusal can still surface on a race (card moved between meta-load and the move POST).