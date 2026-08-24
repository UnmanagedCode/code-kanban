# Report to the board

This project reports its work to the conductor's `code-kanban` board.

- **Proactively file** substantive work you discover (a bug, a follow-up, a discovery you
  shouldn't just fix inline) with `file_card`, passing title/goal/acceptance only — leave `epic`
  to the conductor.
- **Log one short line per meaningful step** via `log_card`. If it returns
  `{ok:false, code:"CARD_UNKNOWN"}`, the conductor hasn't assigned you a card yet — say so and
  carry on; don't retry in a loop.
- Don't block on the board — the conductor triages `triage` on its own cadence.
