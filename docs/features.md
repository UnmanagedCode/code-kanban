# Features

code-kanban gives the **conductor** a persistent, file-backed **private task board**,
exposed as code-conductor MCP tools (`mcp__code-conductor__code-kanban__*`). It is the
conductor's own tool — not a team/shared surface.

## Board model

- **Columns / lifecycle:** `triage → backlog → todo → in-progress → done`.
  - `triage` is an intake inbox; its only exits are `backlog` **or** `todo` (both first-class).
  - There is deliberately **no `review` column** — review is a conductor process; a card stays
    in `in-progress` through review and only reaches `done` on landing.
- **Tasks:** one markdown file per task, with a Goal, Acceptance checklist, and an append-only
  Logbook. IDs are server-assigned, per-project, sortable (`2026-0042`).
- **Epics:** first-class (`goal` + a per-state rollup computed on read). A task carries an optional
  `epic` slug. Splitting an epic needs no verb — file N tasks sharing the same `epic`. An epic is
  either **project-scoped** or **cross-project** (spans ≥2 projects, rollup aggregated across all
  members); a task's slug joins whichever kind covers its project.

## Duties (who may do what)

- The **conductor** is the sole reader and sole mutator: all moves, updates, epics, and reads.
- **Workers are pure emitters** — only `file_task` and `log_progress`, no reads. A worker never
  handles a task id: `log_progress` resolves the target card **server-side from the caller's
  session** (the card the conductor assigned it in `in-progress`).

## Tools

| Tool | Who | Effect |
|------|-----|--------|
| `file_task` | worker + conductor | Create a task in `triage`; returns the new id. |
| `log_progress` | worker + conductor | Append a logbook line to the session's owned in-progress card. |
| `list_tasks` | conductor | List tasks, optionally filtered by `state`/`epic`. |
| `read_task` | conductor | Read one task (+ logbook, optionally last `logTail`). |
| `read_progress` | conductor | Read a task's logbook only, most-recent first. |
| `move_task` | conductor | Move between states; sets `owner` on entering `in-progress`; on landing (`→done`), stamps `commit` (given, or auto-captured from the project's HEAD). |
| `update_task` | conductor | Update `title`/`goal`/`epic`/`priority`/`depends_on`. |
| `create_epic` | conductor | Create/refresh an epic — `project` (project-scoped) or `projects` (cross-project). |
| `list_epics` | conductor | A project's epics + cross-project epics spanning it, with computed rollups. |
| `read_epic` | conductor | One epic (+ rollup) and its tasks; cross-project epics aggregate across members. |

Every tool takes a `project` (validated against the live project list), except `create_epic`/
`read_epic`, which instead accept a cross-project epic's `projects` list / a bare slug.

## Web GUI

A local web app to view + manage the board is served at `/` (manifest `frontend.path`). It is a
**secondary** surface: zero-build vanilla ESM (`frontend/`), served in-process by `express.static`
so it shares the same `board.js` service layer and per-project mutex as the MCP tools — one writer.

- **Project selector** — picks from the live project catalog (`GET /api/projects`); auto-selects
  the first project on load.
- **Board** — five columns rendered from `STATES`; cards show id, title, epic/priority/owner
  badges. A card's legal move targets come from `GET /api/board/meta` (the single source
  `ALLOWED_TRANSITIONS`), so the GUI never offers an illegal move.
- **Card detail** — Goal, Acceptance checklist (read-only), the append-only Logbook, and (once
  landed) the Commit hash; a Move control and an Edit form (title/goal/epic/priority/depends_on).
  Acceptance and Commit are not editable in the GUI.
- **Epics** — rollup table; "open" reads one epic (+ its tasks). New-epic form upserts by slug; its
  "Span projects" multi-select makes a cross-project epic when ≥2 are picked (else project-scoped).
  Cross-project epics show a badge + member list; their detail lists each task's project.
- **New task** — files into `triage` (acceptance is one line per line → checkboxes).

Domain refusals (illegal move, unknown project/epic) surface as a status-line message, not a
transport error — see `docs/protocol.md`. GUI mutations are attributed to `gui` in the logbook
(the GUI has no human identity); `board.js` clears `owner` on any non-`in-progress` move, so a GUI
move never leaves a stuck owner.
