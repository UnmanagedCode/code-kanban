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
- The conductor owns no card, so it can't use the session path. Instead it may pass `log_progress`
  an explicit `id` (+ required `project`) to log against that exact `in-progress` card directly,
  bypassing the owner check. Workers never pass `id`.

## Tools

| Tool | Who | Effect |
|------|-----|--------|
| `file_task` | worker + conductor | Create a task in `triage`, or directly in `todo`/`backlog` via `category`; returns the new id. |
| `log_progress` | worker + conductor | Append a logbook line: worker's owned in-progress card (no `id`), or conductor's target card (`id` + `project`). |
| `list_tasks` | conductor | List tasks, optionally filtered by `state`/`epic`. |
| `read_task` | conductor | Read one task (+ logbook, optionally last `logTail`). |
| `read_progress` | conductor | Read a task's logbook only, most-recent first. |
| `move_task` | conductor | Move between states; sets `owner` on entering `in-progress`; on landing (`→done`), stamps `commit` (given, or auto-captured from the owning worker's live worktree HEAD). |
| `update_task` | conductor | Update `title`/`goal`/`epic`/`priority`/`depends_on`. |
| `create_epic` | conductor | Create/refresh an epic — `project` (project-scoped) or `projects` (cross-project). |
| `list_epics` | conductor | A project's epics + cross-project epics spanning it, with computed rollups. |
| `read_epic` | conductor | One epic (+ rollup) and its tasks; cross-project epics aggregate across members. |
| `delete_task` | conductor | Permanently delete a task by id. Irreversible; not sync-aware (see "Cross-instance sync" in `docs/architecture.md`). |

Every tool takes a `project` (validated against the live project list), except:
- `create_epic`/`read_epic`, which instead accept a cross-project epic's `projects` list / a bare slug.
- `log_progress`'s worker path (no `id`), where `project` is optional: if omitted, the server
  scans every project for the caller's owned in-progress card. `log_progress`'s conductor path
  (`id` given) requires `project` (see `.wiki/gotchas/owner-from-caller-sessionid.md`).

## Web GUI

A local web app to view + manage the board is served at `/` (manifest `frontend.path`). It is a
**secondary** surface: zero-build vanilla ESM (`frontend/`), served in-process by `express.static`
so it shares the same `board.js` service layer and per-project mutex as the MCP tools — one writer.

- **Project selector** — picks from the live project catalog (`GET /api/projects`); auto-selects
  the first project on load, and remembers your last pick in the browser (`localStorage` key
  `code-kanban:selected-project`) so a reload or revisit restores it — falling back to the first
  project if the saved pick no longer exists.
- **Board** — five columns rendered from `STATES`; cards show id, title, epic/priority/owner
  badges. A card's legal move targets come from `GET /api/board/meta` (the single source
  `ALLOWED_TRANSITIONS`), so the GUI never offers an illegal move.
- **Card detail** — opens to a read-only view: Goal, Priority, Acceptance checklist, the
  append-only Logbook, and (once landed) the Commit hash, plus a Move control. An Edit button
  swaps in a form (title/goal/epic/priority/depends_on); Save or Cancel returns to the read view.
  Acceptance, Logbook, and Commit are not editable in the GUI.
- **Epics** — rollup table; "open" reads one epic (+ its tasks). New-epic form upserts by slug; its
  "Span projects" multi-select makes a cross-project epic when ≥2 are picked (else project-scoped).
  Cross-project epics show a badge + member list; their detail lists each task's project.
- **New task** — files into `triage` (acceptance is one line per line → checkboxes).
- **Sync** — opens a dialog to sync with another instance on a different machine: it shows THIS
  board's URL (copyable — share it with the peer), a field for the PEER board's URL, and a scope
  selector (this project / all projects). Clicking **Pull from peer** does a **one-way pull**: it
  fetches the peer's full board for the scope and merges it in, newer-edit-wins per card (union,
  never deletes). Sync is two-click — click it on the peer too to make both machines converge. The
  status line reports what changed (cards added / updated / re-id'd, epics added / updated /
  conflicts, dropped deps / skipped). **Epics sync too**: a synced card's `epic:` slug resolves to a
  real epic on the other machine and its rollup counts it. Epics union by slug with whole-epic
  last-edit-wins (project epics and cross-project epics both). See `docs/architecture.md`
  "Cross-instance sync".

Domain refusals (illegal move, unknown project/epic) surface as a status-line message, not a
transport error — see `docs/protocol.md`. GUI mutations are attributed to `gui` in the logbook
(the GUI has no human identity); `board.js` clears `owner` on any non-`in-progress` move, so a GUI
move never leaves a stuck owner.
