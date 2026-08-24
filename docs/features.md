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
- **Plans:** a task may carry an optional **link to a plan file** (never the plan text), so work
  planned days earlier outlives the worker that planned it — a parked-with-plan card is just `todo`
  plus that link. Set it at filing time (`file_task`'s `plan`) or later with `update_task`. Two
  kinds of input: a **typed pointer** (`board:<rel>`/`repo:<rel>`, or a bare relative path meaning
  `board:`) is validated and linked in place, never copied; an **absolute path** is **ingested** —
  the file is copied into the board as `plans/<id>.md` and the card stores `board:<id>.md`. Ingest
  is what makes a plan the host wrote outside the projects tree (a plan wake's
  `~/.claude/plans/<slug>.md`) attachable in one call, with no hand-run `cp`. It is a **snapshot**:
  an absolute path at an in-tree file copies it rather than tracking it — pass `repo:<rel>` for a
  live pointer. Input forms, the stored form and refusals: `docs/protocol.md` (`update_task`).
- **Priority:** a card carries one of `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, or is **unset**. Unset is
  not a level — it means *nobody has judged this card yet*, which is the honest state of a
  worker-filed card until someone reviews it. Omitting `priority` on `file_task` leaves the card
  unset; there is **no default**, because a fabricated `MEDIUM` is indistinguishable from a
  deliberate one afterwards. Set it at filing time (`file_task`'s `priority`, or the GUI's New-task
  form); change it later with `update_task`, which also accepts `null` to clear a level back to
  unset. Listings sort by **column first, then priority CRITICAL→LOW, then unset, then id** — an
  unjudged card never outranks a judged one. An unrecognised value from a live caller is refused
  `INVALID_STATE`; a value read off disk is never refused — see "legacy tolerance" in
  `docs/architecture.md`.
- **Epics:** first-class (`goal` + a per-state rollup computed on read). A task carries an optional
  `epic` slug. Splitting an epic needs no verb — file N tasks sharing the same `epic`. An epic is
  either **project-scoped** or **cross-project** (spans ≥2 projects, rollup aggregated across all
  members); a task's slug joins whichever kind covers its project.
- **Epic plan + logbook:** an epic carries the same two things a card does, and the split between
  them is the point — an epic outlives every card under it, so its backing reasoning has somewhere
  durable to live instead of dying in a plan worker's transcript.

  | half | carries | must NOT carry |
  |---|---|---|
  | the epic **plan** (a file, linked via `create_epic`'s `plan`) | *strategy* — why these choices, why the dependency graph looks the way it does | the graph itself (`depends_on` owns it), progress (the rollup owns it) |
  | the epic **logbook** (in the epic record, via `log_epic`) | *state* — what landed, what got resequenced and why | strategy (the plan owns it) |

  The plan link takes the same three input forms a card's does; an absolute path is ingested to
  `plans/epic-<slug>.md`. A **cross-project** epic has no owning project, so its `board:` plans
  live in a **board-level** `plans/` dir and `repo:` is refused. Logging to an epic has **no lane
  gate** — an epic has no state, and the entries most worth having (a resequencing decision before
  any card starts, a retrospective after the last one lands) happen with nothing in progress.
  `read_epic` returns the plan link, the resolved `plan_path` and the logbook by default — in
  **chronological** order, alongside `logbook_total` (the full length before any `logTail` cap, so
  a tail'd read can tell 5 entries from 50). It is conductor-only, like every other epic verb.

## Duties (who may do what)

- The **conductor** is the sole reader and sole mutator: all moves, updates, epics, and reads.
- **Workers are pure emitters** — only `file_task` and `log_card`, no reads. A worker never
  handles a task id: `log_card` resolves the target card **server-side from the caller's
  session** (the card the conductor assigned it in `in-progress`).
- The conductor owns no card, so it can't use the session path. Instead it may pass `log_card`
  an explicit `id` (+ required `project`) to log against that exact `in-progress` card directly,
  bypassing the owner check. Workers never pass `id`.

## Tools

| Tool | Who | Effect |
|------|-----|--------|
| `file_task` | worker + conductor | Create a task in `triage`, or directly in `todo`/`backlog` via `category`; takes `priority` (`CRITICAL`/`HIGH`/`MEDIUM`/`LOW`; omit to leave it unset — no default) and an optional `plan` (pointer or an absolute path copied in as `plans/<id>.md`); returns the new id (plus the stored `plan` link when given). |
| `log_card` | worker + conductor | Append a logbook line to a card: the worker's owned in-progress card (no `id`), or the conductor's target card (`id` + `project`). |
| `list_tasks` | conductor | List tasks, optionally filtered by `state`/`epic`; hides `done` by default (`state:'done'`, or `includeDone:true` for every lane). |
| `read_task` | conductor | Read one task (+ logbook, optionally last `logTail`); always returns the resolved plan path, and with `includePlan` the plan file's body. |
| `read_progress` | conductor | Read a task's logbook only, most-recent first. |
| `move_task` | conductor | Move between states; sets `owner` on entering `in-progress`; on landing (`→done`), stamps `commit` (given, or auto-captured from the owning worker's live worktree HEAD). |
| `update_task` | conductor | Update `title`/`goal`/`epic`/`priority` (same four levels, or `null` to clear back to unset)/`depends_on`, attach or clear the `plan` link (pointer, or an absolute path copied in as `plans/<id>.md`; the stored link comes back in the result), edit the `acceptance` list (`{ops:[…]}` add/remove/rename/done, `{replace:[…]}`, or `null` to clear), and reassign `owner` on an in-progress card (plan worker → implementer, no lane move). |
| `create_epic` | conductor | Create/refresh an epic — `project` (project-scoped) or `projects` (cross-project) — plus an optional `plan` link (pointer, or an absolute path copied in as `plans/epic-<slug>.md`). An idempotent upsert that **preserves every optional field you omit**; `goal: ''` / `plan: null` clear one explicitly. |
| `list_epics` | conductor | A project's epics + cross-project epics spanning it, with computed rollups. |
| `read_epic` | conductor | One epic (goal + plan link + logbook + `logbook_total` + rollup) and its tasks; cross-project epics aggregate across members. Always returns the resolved plan path, and with `includePlan` the plan file's body. |
| `log_epic` | conductor | Append a logbook line to an epic — no lane gate, since an epic has no state. |
| `delete_task` | conductor | Permanently delete a task by id, plus its `board:` plan file (never a `repo:` one). Irreversible; not sync-aware (see "Cross-instance sync" in `docs/architecture.md`). |

Every tool takes a `project` (validated against the live project list), except:
- `create_epic`/`read_epic`, which instead accept a cross-project epic's `projects` list / a bare slug.
- `log_card`'s worker path (no `id`), where `project` is optional: if omitted, the server
  scans every project for the caller's owned in-progress card. `log_card`'s conductor path
  (`id` given) requires `project` (see `.wiki/gotchas/owner-from-caller-sessionid.md`).
- `read_epic`/`log_epic`, where `project` is optional and resolves the epic the same way for both
  (one shared resolver): given, it selects that project's own epic first and falls back to a
  cross-project epic covering it; omitted, a cross-project epic is addressed by slug alone.

## Web GUI

A local web app to view + manage the board is served at `/` (manifest `frontend.path`). It is a
**secondary** surface: zero-build vanilla ESM (`frontend/`), served in-process by `express.static`
so it shares the same `board.js` service layer and per-project mutex as the MCP tools — one writer.

- **Project selector** — picks from the live project catalog (`GET /api/projects`); auto-selects
  the first project on load, and remembers your last pick in the browser (`localStorage` key
  `code-kanban:selected-project`) so a reload or revisit restores it — falling back to the first
  project if the saved pick no longer exists.
- **Board** — five columns rendered from `STATES`; cards show id, title, epic/priority/owner/plan
  badges (the plan badge's tooltip is the link). **Every judged level badges** — `CRITICAL`, `HIGH`,
  `MEDIUM` and `LOW` — so a card with no priority badge means exactly one thing: nobody has judged
  it yet. (Badging only some levels would make bare ambiguous between a judgement and the absence of
  one, which are the two states a board most needs to separate.) A **Has plan** checkbox in the top bar filters the
  board to cards carrying a plan link (client-side, not remembered across reloads). A card's legal
  move targets come from `GET /api/board/meta` (the single source `ALLOWED_TRANSITIONS`), so the
  GUI never offers an illegal move.
- **Card detail** — opens to a read-only view: Goal, Priority (always stated, reading `unset` when
  the card is unjudged rather than showing blank),
  Acceptance checklist, the
  append-only Logbook, (once landed) the Commit hash, and — when the card has a plan link — a Plan
  section showing the link plus the plan file's text (`(file not found)` for a dead link,
  `(truncated)` past the size cap), plus a Move control. An Edit button swaps in a form
  (title/goal/acceptance/epic/priority/depends_on), with acceptance as a one-criterion-per-line
  textarea that preserves ticks on unchanged text and clears the list when left empty; priority is
  a **select** over the four levels (never a
  number field), populated from `GET /api/board/meta`'s `priorities` and led by an `— unset —`
  option that clears the level. Save or Cancel returns to the
  read view. Logbook, Commit and the plan link are not editable in the GUI. Acceptance **is**
  editable: the Edit form's textarea round-trips one criterion per line, keeping a criterion's tick
  when its text is unchanged; saving with an empty box clears the list. Per-item ticking (toggling a
  single checkbox without touching the wording) is not exposed in the GUI — use `update_task`'s
  `{op:'done'}` over MCP for that, so the read-view checkboxes stay `disabled`.
- **Epics** — rollup table; "open" reads one epic (+ its tasks). New-epic form upserts by slug; its
  "Span projects" multi-select makes a cross-project epic when ≥2 are picked (else project-scoped).
  Cross-project epics show a badge + member list; their detail lists each task's project.
- **New task** — files into `triage` (acceptance is one line per line → checkboxes), with a
  Priority select that opens on `— unset —` so the form asks for a level without pre-answering it
  (matching `file_task`: a pre-selected `MEDIUM` would fabricate a judgement the same way a
  server-side default would).
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
