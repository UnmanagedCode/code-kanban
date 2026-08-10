# Protocol — interface contracts

## MCP wire contract

The conductor spawns this plugin as an out-of-process HTTP server and forwards each tool call
to `POST /api/mcp`:

- **Request body:** `{ tool, arguments, caller:{ sessionId, project } }`.
- **Response:** HTTP **200 for every well-formed call**, body `{ result: <any> }` on success or
  `{ error: "<msg>" }` on an envelope failure. Non-200 is a transport-level failure.
- **Raw-text channel (additive):** a success body may instead be `{ meta, text }` — the
  host emits `meta` as one compact-JSON block plus each entry of `text` (always an **array**, in
  order) as a **raw, unescaped** content block after it (code-conductor
  `src/plugins/mcpBridge.ts` → `src/mcp/content.ts` `textPayload`). An empty `text` array emits the
  metadata block alone. A body on this path has **no `result` key**.

  **The split rule** (one rule, decided in `src/mcp.js`): a field gets its own raw text block when
  it is *authored prose or a markdown document* — free text a human wrote and an LLM reads
  top-to-bottom. Everything a caller **branches on** stays in the single compact-JSON metadata
  block: scalars, ids, counts, flags, and arrays of record summaries. Author's test: *would this
  field, printed alone, read as a document?* → text block. *Is it a scalar, or a table of records?*
  → JSON. A list of summaries is **data even though it contains title strings**.

  | tool | JSON metadata block | raw text block(s), in order |
  |---|---|---|
  | `read_task` | `{ok, task:{…frontmatter scalars…}, plan_path[, plan_body, plan_truncated, plan_missing]}` | 1. the card body 2. `plan_body` (only with `includePlan` **and** a non-empty readable file) |
  | `read_progress` | `{ok, total, count}` | the logbook entries as a `- `-prefixed list |
  | `read_epic` | `{ok, epic:{slug,title,rollup[,projects]}, tasks:[summary]}` | `epic.goal` (block omitted when empty) |
  | `list_tasks`, `list_epics`, every mutator | unchanged `{result}` | — |

  `meta.task` stays **nested and complete** — every frontmatter scalar including `title` and
  `updated` — minus the three body sections that moved into the text block.
  The channel is **MCP-only**: the GUI's HTTP routes bypass `src/mcp.js` and keep reading these as
  plain JSON fields.
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

**Refusal codes:** `PROJECT_UNKNOWN`, `TASK_UNKNOWN`, `EPIC_UNKNOWN`, `EPIC_CONFLICT`, `INVALID_STATE`,
`PLAN_UNKNOWN`.

## Tool signatures

- `file_task({project, title, goal?, acceptance?, epic?, depends_on?, category?, priority?}) → {ok, id}` — task lands in `triage` by default; `category: 'todo'|'backlog'` lands it directly in that lane instead (mirrors triage's legal exits). An illegal `category` value → `INVALID_STATE`. `epic` must already exist → else `EPIC_UNKNOWN`. `priority` is one of `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` (advertised in the manifest as an `enum` with **no `default`**); omitted or `null` → unset; anything else → `INVALID_STATE`. All of these validate **before** the card is written, so a refusal consumes no id.
- `log_progress({project?, id?, entry}) → {ok}` — two paths, chosen by `id`:
  - **`id` omitted (worker path):** target card resolved server-side from `caller.sessionId`
    (the owned `in-progress` card; ties broken by most-recently-modified). `project` is
    optional: if omitted, every project is scanned for the owned card (same tie-break, across
    projects). No owned card / no session → `TASK_UNKNOWN`.
  - **`id` given (conductor path):** targets that exact card directly, bypassing the owner
    check. `project` is then **required** (ids are per-project, not globally unique) — missing
    → `INVALID_STATE`. Card must be `in-progress`; nonexistent or not `in-progress` →
    `TASK_UNKNOWN`. Logged with `conductor` attribution.
- `list_tasks({project, state?, epic?}) → {ok, tasks:[summary]}`.
- `read_task({project, id, logTail?, includePlan?}) → {ok, task, plan_path[, plan_body, plan_truncated, plan_missing]}` —
  the plan fields are **top-level** on the envelope, never inside `task` (which mirrors frontmatter
  1:1). `plan_path` (the resolved absolute path) is returned **always**, `includePlan` or not; it is
  `null` when the card has no link or the stored link is ungrammatical (e.g. synced from a newer
  peer). `includePlan: true` (default `false`) adds `plan_body` — the plan file read up to a fixed
  **64 KiB** cap (`PLAN_MAX_BYTES` in `src/board.js`; not caller-settable) — plus
  `plan_truncated` (file larger than the cap) and `plan_missing` (a link exists but its file is
  absent/unreadable, incl. a symlink pointing out of its base dir). A dead link is **never a
  refusal**: `plan_body: null, plan_missing: true`. No link at all → `plan_body: null,
  plan_missing: false`.

  **Over MCP the result is not one JSON object.** It is **always** a compact-JSON metadata block
  (`{ok, task, plan_path[, plan_body, plan_truncated, plan_missing]}` — `task` minus `goal`/
  `acceptance`/`logbook`) followed by the **card body** as a raw, unescaped markdown
  block (`## Goal` / `## Acceptance` as real `- [ ]` checkboxes / `## Logbook`), then — only when
  `includePlan` read a non-empty file — the plan verbatim as a **second** raw block. The card body is
  re-rendered from the task object via `taskfile.serializeBody`, so `logTail` and hidden-field
  stripping apply to it exactly as to the metadata.

  `plan_body` is promoted **out of** `meta` only when it is a string, and a block is emitted only
  when that string is non-empty. So with `includePlan: true` there are three outcomes:
  a body was read → no `plan_body` in `meta`, second block present; the file exists but is
  **empty** → no `plan_body` in `meta`, **no** second block, `plan_missing: false`; no link or an
  unreadable file → `plan_body: null` **stays in `meta`** (null is not a string) alongside
  `plan_missing`.

  The empty-file case and "`includePlan` not passed" are told apart by the **presence of
  `plan_missing`/`plan_truncated`** — set (to `false`) only when `includePlan` was passed, absent
  otherwise. Not by `plan_path`, which is returned always and reflects the card's *link*, not the
  flag (`src/board.js` assigns it outside the `includePlan` branch), so it is non-null for both
  calls on a linked card. Over the GUI's HTTP route it stays a single
  JSON object with `goal`/`acceptance`/`logbook`/`plan_body` as fields (`src/routes.js` delegates
  to `board.js`, which is unchanged; only `src/mcp.js` splits).
- `read_progress({project, id, limit?}) → {ok, entries:[…], total}` — most-recent first.
  **Over MCP:** metadata block `{ok, total, count}` (`count` = entries returned after `limit`;
  `total` = the card's full logbook length) plus the entries as one raw `- `-prefixed markdown
  block. Zero entries → metadata block only.
- `move_task({project, id, to, owner?, commit?}) → {ok, from, to}`. Legal transitions:
  `triage→backlog`, `triage→todo`, `backlog→todo`, `todo→in-progress`, `in-progress→done`,
  and corrective `todo→backlog`, `in-progress→todo`, `done→in-progress`. Anything else
  (unknown state, same-state no-op, other pair) → `INVALID_STATE`. `owner` is stored only while
  in `in-progress` and cleared on leaving it. On landing (`→done`), `commit` is stamped if given,
  else auto-captured as the owning worker's live worktree HEAD sha (resolved via the conductor's
  `/api/instances`, using the prior `in-progress` owner's session id) — never the base project
  checkout's HEAD, which won't contain a worktree'd worker's commits until a merge. Failing to
  resolve either way is not an error — the move still succeeds and `commit` is simply left unset.
  A re-land (`done→in-progress→done`) re-runs this resolution: a fresh sha overwrites the prior
  one, but an unresolvable re-land leaves the previously-stamped `commit` untouched.
- `update_task({project, id, fields}) → {ok}` — `fields` ⊆ `{title, goal, epic, priority, depends_on, plan, owner}`; other keys ignored. `fields.epic` must exist → else `EPIC_UNKNOWN`. Every field validates **before** any mutation, so a refusal leaves the card untouched.
  - **`priority`** — one of `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, matched **exactly** (case-sensitive),
    **or `null` to clear the card back to unset** (like `plan`). Everything else — `''`, a lowercase
    spelling, a legacy integer, `undefined`, any unknown word → `INVALID_STATE`. Only an explicit
    `null` clears, so a dropped or misspelled value cannot silently erase a judgement. Tolerant
    coercion exists **only** on the disk-parse path, never here — see
    `.wiki/gotchas/priority-legacy-tolerance.md`.
  - **`plan`** — a **link to a plan file**, never the plan text. Grammar (defined here, once):
    `board:<rel>` resolves under `<kanbanRoot>/projects/<project>/plans/`; `repo:<rel>` resolves
    under `<PROJECTS_ROOT>/<project>/` — the **base checkout**, never a worktree, so a `repo:` link
    only resolves once the plan is merged; a **bare** `<rel>` means `board:` and is stored
    normalised to the explicit `board:<rel>` form. Refused `INVALID_STATE`: an empty value, a
    non-string, an embedded newline (frontmatter is one verbatim line), any other scheme
    (`file:`, `http:`, `C:\…`), an **absolute** path (breaks cross-instance sync), and `../`
    escaping the base. Refused `PLAN_UNKNOWN` when the link is grammatical but resolves to no
    regular file inside its base (incl. via a symlink out of it). `plan: null` clears it.
  - **`owner`** — only settable on an **`in-progress`** card → else `INVALID_STATE` (a plan-worker →
    implementer handoff needs no lane move). Must be a non-empty single token with no whitespace;
    `null` clears it. A real change stamps a logbook line `owner <from> -> <to>` (`none` for an
    absent side); a no-op set logs nothing.
- `create_epic({project?, projects?, slug, title, goal?}) → {ok}` — `slug` matches `^[a-z0-9._-]+$`; idempotent upsert (re-creating refreshes title/goal, preserves `created`; for a cross-project epic it also **replaces the member `projects` list** — membership is mutable). Give **exactly one** of `project` (project-scoped) or `projects` (a cross-project epic spanning ≥2 members) → else `INVALID_STATE`. A slug may not be both a cross-project epic and a per-project epic in one of its members → `EPIC_CONFLICT` (guarded in both create orders).
- `list_epics({project}) → {ok, epics:[{slug, title, rollup, projects}]}` — the project's own epics (`projects:null`) plus cross-project epics spanning it (`projects:[…]`, `rollup` aggregated over all members).
- `read_epic({project?, slug}) → {ok, epic:{slug,title,goal,rollup[,projects]}, tasks:[summary]}` — with `project`, a project-scoped epic resolves first, else a cross-project epic covering it. Omit `project` to read a cross-project epic by slug; its `rollup` and `tasks` aggregate across all member projects and `epic.projects` lists them. **Over MCP:** metadata block `{ok, epic:{slug,title,rollup[,projects]}, tasks:[summary]}` plus `epic.goal` as one raw markdown block (omitted when the goal is empty); `tasks` stays JSON — a table of summaries is data.
- `delete_task({project, id}) → {ok}` — permanently removes the task's file; unknown id → `TASK_UNKNOWN`. Also best-effort removes the card's plan file **when the link is `board:`** — a `repo:` plan is a source-tree file and is never touched; a failed unlink leaves an orphan, never a refusal. Irreversible and not sync-aware: see "Cross-instance sync" in `docs/architecture.md`.

A `summary` is `{id, title, state, project, epic, priority, owner, depends_on, created, plan}`
(`plan` is the link, or `null`; `priority` is one of the four levels, or `null` when the card is
unset — i.e. nobody has judged it). Task
lists (`list_tasks`, `read_epic`) are ordered **column (`STATES` order) → priority
(`CRITICAL`→`HIGH`→`MEDIUM`→`LOW`→unset) → id ascending**; unset ranks after every judged level, so
an unjudged card never outranks a judged one. A `rollup`
is a per-state count object over `triage/backlog/todo/in-progress/done`. `file_task`/`update_task`
accept an `epic` slug that resolves to a per-project epic in the task's project **or** a
cross-project epic covering it → else `EPIC_UNKNOWN`. The full task object (from `read_task`)
additionally carries an optional `commit` field, set once the task lands; `commit` is not in
`update_task`'s `UPDATABLE` set — it's stamped only by `move_task`. `plan`, by contrast, **is** in
`UPDATABLE` — it is the one card field a caller sets directly.

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
| `GET /api/board/meta` | `STATES` + `ALLOWED_TRANSITIONS` + `PRIORITIES` | — | `{states:[…], transitions:["from>to",…], priorities:["CRITICAL","HIGH","MEDIUM","LOW"]}` (`priorities` in rank order, highest first — the GUI's priority selects render from it rather than hardcoding a copy) |
| `GET /api/board/:project/tasks` | `board.listTasks` | `?state`, `?epic` | `{ok, tasks:[summary]}` |
| `GET /api/board/:project/tasks/:id` | `board.readTask` | `?includePlan=1\|true` | `{ok, task, plan_path[, plan_body, plan_truncated, plan_missing]}` (full: goal, acceptance, logbook). Any other `includePlan` value is falsy. The GUI always sends `includePlan=1` and reads `plan_body` as a field (the raw-text channel is MCP-only). |
| `POST /api/board/:project/tasks` | `board.fileTask` | `{title, goal?, acceptance?, epic?, depends_on?, priority?}` | `{ok, id}` (lands in `triage`; `priority` omitted or `null` → unset) |
| `PATCH /api/board/:project/tasks/:id` | `board.updateTask` | body **is** `fields` ⊆ `{title, goal, epic, priority, depends_on, plan, owner}` | `{ok}` (same refusals as the tool, incl. `PLAN_UNKNOWN`) |
| `POST /api/board/:project/tasks/:id/move` | `board.moveTask` | `{to, owner?, commit?}` | `{ok, from, to}` |
| `GET /api/board/:project/epics` | `board.listEpics` | — | `{ok, epics:[{slug, title, rollup, projects}]}` (incl. cross-project epics spanning the project) |
| `GET /api/board/:project/epics/:slug` | `board.readEpic` | — | `{ok, epic, tasks:[summary]}` (resolves a cross-project epic the project belongs to) |
| `POST /api/board/:project/epics` | `board.createEpic` | `{slug, title, goal?}` | `{ok}` (project-scoped) |
| `GET /api/epics/:slug` | `board.readEpic` | — | `{ok, epic, tasks:[summary]}` (cross-project epic by slug) |
| `POST /api/epics` | `board.createEpic` | `{slug, title, goal?, projects:[…]}` | `{ok}` (cross-project epic; `projects` has ≥2 members) |
| `GET /api/sync/export` | `board.exportBoard` | `?scope=project\|all`, `?project` (required for `project`) | `{ok, nodeId, scope, projects:{<project>:[fullCard]}, projectEpics:{<project>:[epic]}, crossEpics:[epic]}` |
| `POST /api/sync/pull` | `board.syncPull` | `{peerUrl, scope, project?}` | `{ok, summary:{added, updated, reassigned[], droppedDeps[], skippedProjects[], skippedCards[], epicsAdded, epicsUpdated, epicConflicts[], skippedEpics[], perProject}}` |

Notes:
- The `POST /epics` route exposes `createEpic`'s **real behavior — an upsert**: an existing slug
  is refreshed (title/goal overwritten) with `created` preserved; it never refuses an existing
  epic. (The tool name `create_epic` is a slight misnomer; it is idempotent upsert.)
- `move` passes `owner: owner || 'gui'`. `board.js` stores `owner` only on entering
  `in-progress` and clears it on leaving, so the `'gui'` attribution affects only the move's
  logbook line (and in-progress ownership) — never a stuck owner on other columns.
- The `meta` route is the GUI's single source for legal move targets; `transitions` is the
  `ALLOWED_TRANSITIONS` Set serialized as `"from>to"` strings.
- **Sync (cross-instance).** `GET /api/sync/export` is the **only** endpoint that exposes a
  card's hidden `uid`/`node`; every other read (`read_task`, `/tasks/:id`, summaries) strips
  them. It is read-only from the caller's view but lazily backfills the version stamp on any
  legacy card it serves. No auth: possession of the code-hub-forwarded URL is the capability.
  `POST /api/sync/pull` fetches the peer's export (`<peerUrl>/api/sync/export`) **backend-to-backend**
  (avoids browser CORS) and merges by `uid` (union + card-level last-edit-wins). The pull summary
  contains **display ids/slugs/counts only** — never `uid`/`node` (it reaches the GUI). Malformed peer
  cards (missing/non-string `id`, or an unknown column) are skipped and listed in `skippedCards`.
  **Epics** are exported (`projectEpics`/`crossEpics`) and merged BEFORE cards, matched by **slug**
  (whole-epic last-edit-wins; hidden `updated`/`node` exposed only by export, never by `read_epic`/
  `list_epics`). A slug that is a project epic on one side and cross-project on the other is skipped +
  reported in `epicConflicts` (never merged/deleted — grow-only); malformed epics (bad slug / cross
  epic with <2 members) go to `skippedEpics`.
  Refusals: malformed `peerUrl` or a blocked host → 200 `{ok:false, INVALID_STATE}`; an
  unreachable/garbage/oversized peer → 200 `{ok:false, SYNC_UNREACHABLE}`.
  **SSRF guard**: `peerUrl` pointing at a loopback / private / link-local IP literal
  (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` incl. `169.254.169.254`, `::1`,
  `fc00::/7`, `fe80::/10`, `localhost`) is refused; the peer fetch does not follow redirects and is
  bounded by a 15 s timeout + 25 MB size cap. Hostnames are not DNS-resolved (lightweight guard —
  a code-hub peer is a public host); set `CODE_KANBAN_SYNC_ALLOW_PRIVATE=1` to permit private
  targets for local dev / the visual harness. See `docs/architecture.md` and
  `.wiki/architecture/cross-instance-sync.md`.
