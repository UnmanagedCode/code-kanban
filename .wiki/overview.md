# Overview

code-kanban is a **code-conductor plugin** that gives the **conductor** a persistent,
file-backed **private task board**, exposed as `mcp__code-conductor__code-kanban__*` tools.
The plugin CODE lives in this repo; the board DATA it manages lives in the conductor's tree
under `<.conduct>/kanban/`.

## Glossary

- **conductor** — the orchestrating session. The board's **sole reader and sole mutator**.
- **worker** — a spawned session. A **pure emitter**: only `file_task` and `append_log`, no
  reads, and it never handles a task id.
- **owner** — the worker's `sessionId`, stamped on a card only while it is `in-progress`.
- **triage** — the intake inbox column; its only exits are `backlog` or `todo`.
- **epic** — a project-scoped grouping (`goal` + computed per-state rollup); tasks carry a slug.
- **rollup** — per-state task counts for an epic, computed on read, never stored.

## Two firm invariants (don't regress)

1. **Single writer via one mutex.** Every mutation goes through `board.js` inside
   `withLock(project, …)`. This is what makes id assignment and moves race-free without git or
   file locks. Adding a second write path (a separate process, a direct file write) breaks it.
2. **No `review` column.** Review is a conductor process; a card stays `in-progress` through
   review and only moves to `done` on landing. Don't add a state for it.

See [[service-layer-seam]] and [[file-store-layout]] for the store; [[result-envelope-vs-ok-shape]]
for the tool result convention.
