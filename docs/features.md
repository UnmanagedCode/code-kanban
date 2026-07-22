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
- **Epics:** first-class, project-scoped (`goal` + a per-state rollup computed on read). A task
  carries an optional `epic` slug. Splitting an epic needs no verb — file N tasks sharing the
  same `epic`.

## Duties (who may do what)

- The **conductor** is the sole reader and sole mutator: all moves, updates, epics, and reads.
- **Workers are pure emitters** — only `file_task` and `append_log`, no reads. A worker never
  handles a task id: `append_log` resolves the target card **server-side from the caller's
  session** (the card the conductor assigned it in `in-progress`).

## Tools

| Tool | Who | Effect |
|------|-----|--------|
| `file_task` | worker + conductor | Create a task in `triage`; returns the new id. |
| `append_log` | worker + conductor | Append a logbook line to the session's owned in-progress card. |
| `list_tasks` | conductor | List tasks, optionally filtered by `state`/`epic`. |
| `read_task` | conductor | Read one task (+ logbook, optionally last `logTail`). |
| `read_log` | conductor | Read a task's logbook only, most-recent first. |
| `move_task` | conductor | Move between states; sets `owner` on entering `in-progress`. |
| `update_task` | conductor | Update `title`/`goal`/`epic`/`priority`/`depends_on`. |
| `create_epic` | conductor | Create/refresh a project-scoped epic. |
| `list_epics` | conductor | Epics with computed rollups. |
| `read_epic` | conductor | One epic (+ rollup) and its tasks. |

Every tool takes a required `project`, validated against the live project list.

## Web GUI

A local web app to view + manage the board is planned as a **secondary** surface, built
separately. It runs inside this plugin's process and consumes the same `board.js` service
layer — see `docs/architecture.md` and `.wiki/architecture/service-layer-seam.md`.
