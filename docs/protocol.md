# Protocol — interface contracts

## MCP wire contract

The conductor spawns this plugin as an out-of-process HTTP server and forwards each tool call
to `POST /api/mcp`:

- **Request body:** `{ tool, arguments, caller:{ sessionId, project } }`.
- **Response:** HTTP **200 for every well-formed call**, body `{ result: <any> }` on success or
  `{ error: "<msg>" }` on an envelope failure. Non-200 is a transport-level failure.
- Missing/empty `tool` → **400** `{error}`; unknown tool name → 200 `{error}`.
- `caller.sessionId` may be `null` when the host can't resolve the caller.

## Result payloads (the `{ok}` domain convention)

Tool handlers **return** a domain result as the `{result}` payload and **never throw** for a
domain outcome:

- Success: `{ ok: true, ... }` (e.g. `{ ok: true, id }`).
- Refusal: `{ ok: false, code, reason }`.

So a refusal travels as `{ result: { ok:false, code, reason } }` at HTTP 200 — a normal MCP
result the conductor relays to the model, **not** an `{error}`. `{error}` is reserved for a
malformed envelope or an unexpected exception.

**Refusal codes:** `PROJECT_UNKNOWN`, `TASK_UNKNOWN`, `EPIC_UNKNOWN`, `EPIC_CONFLICT`, `INVALID_STATE`.

## Tool signatures

- `file_task({project, title, goal?, acceptance?, epic?, depends_on?}) → {ok, id}` — task lands in `triage`. `epic` must already exist → else `EPIC_UNKNOWN`.
- `log_progress({project, entry}) → {ok}` — target card resolved server-side from `caller.sessionId` (the owned `in-progress` card; ties broken by most-recently-modified). No owned card / no session → `TASK_UNKNOWN`.
- `list_tasks({project, state?, epic?}) → {ok, tasks:[summary]}`.
- `read_task({project, id, logTail?}) → {ok, task}`.
- `read_progress({project, id, limit?}) → {ok, entries:[…], total}` — most-recent first.
- `move_task({project, id, to, owner?, commit?}) → {ok, from, to}`. Legal transitions:
  `triage→backlog`, `triage→todo`, `backlog→todo`, `todo→in-progress`, `in-progress→done`,
  and corrective `todo→backlog`, `in-progress→todo`, `done→in-progress`. Anything else
  (unknown state, same-state no-op, other pair) → `INVALID_STATE`. `owner` is stored only while
  in `in-progress` and cleared on leaving it. On landing (`→done`), `commit` is stamped if given,
  else auto-captured from the project's HEAD sha; neither resolving is not an error — the move
  still succeeds and the task's `commit` field is simply left unset.
- `update_task({project, id, fields}) → {ok}` — `fields` ⊆ `{title, goal, epic, priority, depends_on}`; other keys ignored. `fields.epic` must exist → else `EPIC_UNKNOWN`.
- `create_epic({project?, projects?, slug, title, goal?}) → {ok}` — `slug` matches `^[a-z0-9._-]+$`; idempotent upsert (re-creating refreshes title/goal, preserves `created`; for a cross-project epic it also **replaces the member `projects` list** — membership is mutable). Give **exactly one** of `project` (project-scoped) or `projects` (a cross-project epic spanning ≥2 members) → else `INVALID_STATE`. A slug may not be both a cross-project epic and a per-project epic in one of its members → `EPIC_CONFLICT` (guarded in both create orders).
- `list_epics({project}) → {ok, epics:[{slug, title, rollup, projects}]}` — the project's own epics (`projects:null`) plus cross-project epics spanning it (`projects:[…]`, `rollup` aggregated over all members).
- `read_epic({project?, slug}) → {ok, epic:{slug,title,goal,rollup[,projects]}, tasks:[summary]}` — with `project`, a project-scoped epic resolves first, else a cross-project epic covering it. Omit `project` to read a cross-project epic by slug; its `rollup` and `tasks` aggregate across all member projects and `epic.projects` lists them.

A `summary` is `{id, title, state, project, epic, priority, owner, depends_on, created}`. A `rollup`
is a per-state count object over `triage/backlog/todo/in-progress/done`. `file_task`/`update_task`
accept an `epic` slug that resolves to a per-project epic in the task's project **or** a
cross-project epic covering it → else `EPIC_UNKNOWN`. The full task object (from `read_task`)
additionally carries an optional `commit` field, set once the task lands; `commit` is not in
`update_task`'s `UPDATABLE` set — it's stamped only by `move_task`.

## Manifest / schema constraints

`conductor.plugin.json` tool `inputSchema`s must be a **flat object schema** (host-enforced):
no `$ref/oneOf/anyOf/allOf/not`, no nested `properties`. Consequence: `update_task.fields` is
advertised as an opaque `{type:"object"}` and validated at runtime. Array params
(`acceptance`, `depends_on`) use `{type:"array", items:{type:"string"}}`.

## Web GUI HTTP routes

The in-process web GUI (`frontend/`, served at `/` by `express.static`) talks to the same
`board.js` service layer over `GET`/`POST`/`PATCH` routes under `/api`. They are a **thin 1:1
delegate**: each route calls the matching `board.js` function and passes its `{ok}` envelope
through unchanged as the HTTP body.

**Envelope rule (same as the MCP bridge):** a domain refusal `{ok:false, code, reason}` is a
**normal result returned as HTTP 200** — not a transport failure. Only malformed JSON
(`entity.parse.failed`) → **400** `{error:"invalid request body"}`, and an unexpected throw →
**500** `{error}`. So `GET /api/board/ghost/tasks` returns 200 `{ok:false, code:"PROJECT_UNKNOWN",
…}`, and an illegal move returns 200 `{ok:false, code:"INVALID_STATE", …}`.

| Method + path | Delegate | Body / query | Returns |
|---|---|---|---|
| `GET /api/projects` | `projects.listProjects` | — | `{projects:[name]}` (502 `{error}` if the catalog fetch throws) |
| `GET /api/board/meta` | `STATES` + `ALLOWED_TRANSITIONS` | — | `{states:[…], transitions:["from>to",…]}` |
| `GET /api/board/:project/tasks` | `board.listTasks` | `?state`, `?epic` | `{ok, tasks:[summary]}` |
| `GET /api/board/:project/tasks/:id` | `board.readTask` | — | `{ok, task}` (full: goal, acceptance, logbook) |
| `POST /api/board/:project/tasks` | `board.fileTask` | `{title, goal?, acceptance?, epic?, depends_on?}` | `{ok, id}` (lands in `triage`) |
| `PATCH /api/board/:project/tasks/:id` | `board.updateTask` | body **is** `fields` ⊆ `{title, goal, epic, priority, depends_on}` | `{ok}` |
| `POST /api/board/:project/tasks/:id/move` | `board.moveTask` | `{to, owner?, commit?}` | `{ok, from, to}` |
| `GET /api/board/:project/epics` | `board.listEpics` | — | `{ok, epics:[{slug, title, rollup, projects}]}` (incl. cross-project epics spanning the project) |
| `GET /api/board/:project/epics/:slug` | `board.readEpic` | — | `{ok, epic, tasks:[summary]}` (resolves a cross-project epic the project belongs to) |
| `POST /api/board/:project/epics` | `board.createEpic` | `{slug, title, goal?}` | `{ok}` (project-scoped) |
| `GET /api/epics/:slug` | `board.readEpic` | — | `{ok, epic, tasks:[summary]}` (cross-project epic by slug) |
| `POST /api/epics` | `board.createEpic` | `{slug, title, goal?, projects:[…]}` | `{ok}` (cross-project epic; `projects` has ≥2 members) |

Notes:
- The `POST /epics` route exposes `createEpic`'s **real behavior — an upsert**: an existing slug
  is refreshed (title/goal overwritten) with `created` preserved; it never refuses an existing
  epic. (The tool name `create_epic` is a slight misnomer; it is idempotent upsert.)
- `move` passes `owner: owner || 'gui'`. `board.js` stores `owner` only on entering
  `in-progress` and clears it on leaving, so the `'gui'` attribution affects only the move's
  logbook line (and in-progress ownership) — never a stuck owner on other columns.
- The `meta` route is the GUI's single source for legal move targets; `transitions` is the
  `ALLOWED_TRANSITIONS` Set serialized as `"from>to"` strings.
