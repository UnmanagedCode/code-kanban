# Project wiki — index

Durable, hard-to-re-derive knowledge for code-kanban. Read this before planning, then the
1–3 pages relevant to your task.

## Overview
- [overview.md](overview.md) — what code-kanban is, glossary, the two firm invariants.

## Gotchas
- [gotchas/conduct-path-resolution.md](gotchas/conduct-path-resolution.md) — resolve `.conduct` via injected env; never hardcode/import.
- [gotchas/flat-inputschema-constraint.md](gotchas/flat-inputschema-constraint.md) — host rejects nested/`oneOf` schemas; the opaque-object trick.
- [gotchas/result-envelope-vs-ok-shape.md](gotchas/result-envelope-vs-ok-shape.md) — `{result}` outer envelope vs `{ok}` domain payload; refusals are never thrown.
- [gotchas/owner-from-caller-sessionid.md](gotchas/owner-from-caller-sessionid.md) — `log_progress` resolves the card from the session; tie-break rule.

## Architecture / decisions
- [architecture/service-layer-seam.md](architecture/service-layer-seam.md) — `board.js` is the single writer + GUI seam; why same-process.
- [architecture/file-store-layout.md](architecture/file-store-layout.md) — store layout, id sequence, the **no-git-writes** decision (plus the one read-only exception: landing stamps a commit hash via `src/git.js`), and **cross-project epics** (slug guard + lock key).
- [architecture/gui-seam-contract.md](architecture/gui-seam-contract.md) — the web GUI's route→`board.js` map, envelope pass-through, `GUI_ACTOR`, read-only logbook/acceptance, the `meta` route.
