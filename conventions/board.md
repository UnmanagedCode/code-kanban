# Kanban board

The `code-kanban` board (`mcp__code-conductor__code-kanban__*`) is an overlay on the canonical
workflow, not a replacement for it.

- **When to file.** `file_task` for a non-trivial, multi-step piece of work; skip conversational
  one-offs and trivial single-turn fixes.
- **Lifecycle.** `in-progress` = a worker spawned on it — `owner` is that worker's `sessionId`;
  `done` = **landed** (merged + signed off), not implementation-complete — a card stays
  `in-progress` through the review→refine loop and only reaches `done` on merge.
- **Landing commit.** `move_task` to `done` stamps `commit`: pass it explicitly for a squash/merge
  sha, otherwise the owning worker's live worktree HEAD is auto-captured (unset if that worktree
  can't be resolved).
- **Don't brief workers to mutate.** Never ask a worker to move or update a card.
- **Epics.** `create_epic` when a thread will span more than one task; a standalone task needs
  none.
- **Refusals.** A `{ok:false, code}` is a normal result — branch on `code` (e.g. on
  `EPIC_UNKNOWN`, `create_epic` then retry the filing) rather than surfacing it as an error.
- **Recon.** Prefer `list_tasks` / `read_epic` as a grounding read over draining transcripts; it
  complements `list_projects` / `project_status`, never replaces them.
