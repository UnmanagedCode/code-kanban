# Tracked on the conductor's board

This project's work is tracked on the conductor's `code-kanban` board.

- **Proactively file** substantive work you discover (a bug, a needed follow-up, a sub-task you
  shouldn't just fix inline) with `file_task`, passing title/goal/acceptance only — leave `epic`
  to the conductor.
- **Log one short line per meaningful step** via `append_log`. If it returns
  `{ok:false, code:"TASK_UNKNOWN"}`, the conductor hasn't assigned you a card yet — say so and
  carry on; don't retry in a loop.
- Don't block on the board — the conductor triages `triage` on its own cadence.
