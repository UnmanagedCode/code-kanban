# Kanban board

The `code-kanban` board (`mcp__code-conductor__code-kanban__*`) is an overlay on the canonical
workflow, not a replacement for it.

- **When to file.** `file_task` for a non-trivial, multi-step piece of work; skip conversational
  one-offs and trivial single-turn fixes. Pass `category: 'todo'|'backlog'` to skip triage when the
  lane is already known; omit it to land in triage (the default).
- **Priority.** Give every card you file a judged level rather than omitting it — unset means nobody
  has judged the card yet and sorts below `LOW`, so "do this last" is `LOW`, not omission.
- **Deleting.** `delete_task` is permanent — no undo, no history, not sync-aware. Prefer it only
  for genuine mistakes/duplicates, not for closing out finished work (`move_task` to `done`).
- **Lifecycle.** `in-progress` = a worker spawned on it — `owner` is that worker's `sessionId`;
  `done` = **landed** (merged + signed off), not implementation-complete — a card stays
  `in-progress` through the review→refine loop and only reaches `done` on merge.
- **Landing commit.** `move_task` to `done` stamps `commit`: pass it explicitly for a squash/merge
  sha, otherwise the owning worker's live worktree HEAD is auto-captured (unset if that worktree
  can't be resolved).
- **Plans.** On a plan wake, attach the plan to the card rather than re-authoring it: pass the
  plan file's absolute path — the one the wake names — as `update_task`'s `plan`. When the plan
  instead lives in the project tree, attach `repo:<rel>` once the merge lands. A card may be
  planned but unstarted — `todo` plus a plan link. Pull the text back with
  `read_task({includePlan:true})` only when you actually need it.
- **Handoff.** `update_task` can reassign `owner` on an `in-progress` card (plan worker ->
  implementer) with no lane move.
- **Don't brief workers to mutate.** Never ask a worker to move or update a card.
- **Epics.** `create_epic` when a thread will span more than one task; a standalone task needs
  none.
- **Refusals.** A `{ok:false, code}` is a normal result — branch on `code` (e.g. on
  `EPIC_UNKNOWN`, `create_epic` then retry the filing) rather than surfacing it as an error.
- **Recon.** Prefer `list_tasks` / `read_epic` as a grounding read over draining transcripts; it
  complements `list_projects` / `project_status`, never replaces them.
