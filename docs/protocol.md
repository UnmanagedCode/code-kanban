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

**Refusal codes:** `PROJECT_UNKNOWN`, `TASK_UNKNOWN`, `EPIC_UNKNOWN`, `INVALID_STATE`.

## Tool signatures

- `file_task({project, title, goal?, acceptance?, epic?, depends_on?}) → {ok, id}` — task lands in `triage`. `epic` must already exist → else `EPIC_UNKNOWN`.
- `append_log({project, entry}) → {ok}` — target card resolved server-side from `caller.sessionId` (the owned `in-progress` card; ties broken by most-recently-modified). No owned card / no session → `TASK_UNKNOWN`.
- `list_tasks({project, state?, epic?}) → {ok, tasks:[summary]}`.
- `read_task({project, id, logTail?}) → {ok, task}`.
- `read_log({project, id, limit?}) → {ok, entries:[…], total}` — most-recent first.
- `move_task({project, id, to, owner?}) → {ok, from, to}`. Legal transitions:
  `triage→backlog`, `triage→todo`, `backlog→todo`, `todo→in-progress`, `in-progress→done`,
  and corrective `todo→backlog`, `in-progress→todo`, `done→in-progress`. Anything else
  (unknown state, same-state no-op, other pair) → `INVALID_STATE`. `owner` is stored only while
  in `in-progress` and cleared on leaving it.
- `update_task({project, id, fields}) → {ok}` — `fields` ⊆ `{title, goal, epic, priority, depends_on}`; other keys ignored. `fields.epic` must exist → else `EPIC_UNKNOWN`.
- `create_epic({project, slug, title, goal?}) → {ok}` — `slug` matches `^[a-z0-9._-]+$`; idempotent upsert.
- `list_epics({project}) → {ok, epics:[{slug, title, rollup}]}`.
- `read_epic({project, slug}) → {ok, epic:{slug,title,goal,rollup}, tasks:[summary]}`.

A `summary` is `{id, title, state, epic, priority, owner, depends_on, created}`. A `rollup` is a
per-state count object over `triage/backlog/todo/in-progress/done`.

## Manifest / schema constraints

`conductor.plugin.json` tool `inputSchema`s must be a **flat object schema** (host-enforced):
no `$ref/oneOf/anyOf/allOf/not`, no nested `properties`. Consequence: `update_task.fields` is
advertised as an opaque `{type:"object"}` and validated at runtime. Array params
(`acceptance`, `depends_on`) use `{type:"array", items:{type:"string"}}`.
