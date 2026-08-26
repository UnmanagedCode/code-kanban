# Project wiki — index

Durable, hard-to-re-derive knowledge for code-kanban. Read this before planning, then the
1–3 pages relevant to your task.

## Overview
- [overview.md](overview.md) — what code-kanban is, glossary, the two firm invariants.

## Gotchas
- [gotchas/conduct-path-resolution.md](gotchas/conduct-path-resolution.md) — resolve `.conduct` via injected env; never hardcode/import.
- [gotchas/flat-inputschema-constraint.md](gotchas/flat-inputschema-constraint.md) — host rejects nested/`oneOf` schemas; the opaque-object trick.
- [gotchas/result-envelope-vs-ok-shape.md](gotchas/result-envelope-vs-ok-shape.md) — `{result}` outer envelope vs `{ok}` domain payload; refusals are never thrown; the host's `{meta,text}` raw-text channel (every read) and what it costs `body.result` readers; `list_cards`' MCP-vs-HTTP default disagreement.
- [gotchas/owner-from-caller-sessionid.md](gotchas/owner-from-caller-sessionid.md) — `log_card` resolves the card from the session; optional `project` scans all projects; tie-break rule; cross-project scan locking; conductor's `id`-based path bypasses ownership (requires `project`).
- [gotchas/plan-link-and-sync-gap.md](gotchas/plan-link-and-sync-gap.md) — the plan LINK syncs but the body doesn't (dead links, and why re-setting one refuses `PLAN_UNKNOWN`), for an epic's plan as much as a card's; `board:`'s base is project-*nullable* (a cross-project epic has no owner → the board-level `plans/` dir; `repo:` refused) and why the `epic-<slug>.md` ingest name is load-bearing; `repo:` needs the merge first; explicit scheme = pointer vs bare absolute = ingest (always copied to `plans/<id>.md`, no location sniffing, snapshot not pointer), the realpath self-copy guard (kept as insurance against *unspecified* `copyFileSync` behaviour — libuv already no-ops a same-inode copy, so its removal is unkillable and waived in mutation-proving), the accepted arbitrary-source read; the newline + realpath guards on a worker-writable `plans/`.
- [gotchas/priority-legacy-tolerance.md](gotchas/priority-legacy-tolerance.md) — strict on caller input vs tolerant on disk reads, why legacy `0` maps to unset (and nothing defaults), and how a pre-enum sync peer strips levels *and* sorts unset to the opposite end of the column.
- [gotchas/detail-overlay-close-button-stacking.md](gotchas/detail-overlay-close-button-stacking.md) — `#detail-overlay`'s close ✕ always paints over `.detail-head` content; new right-aligned buttons there need clearance padding.
- [gotchas/acceptance-line-round-trip.md](gotchas/acceptance-line-round-trip.md) — a criterion is one `- [ ] <text>` line; a newline silently truncates it and empty-after-trim text vanishes, why both mutators refuse those and store trimmed text, and why a wrong-shaped `acceptance`/`depends_on` list is refused rather than coerced to empty.

## Architecture / decisions
- [architecture/service-layer-seam.md](architecture/service-layer-seam.md) — `board.js` is the single writer + GUI seam; why same-process.
- [architecture/file-store-layout.md](architecture/file-store-layout.md) — store layout, id sequence, the **no-git-writes** decision (plus the one read-only exception: landing stamps a commit hash read from the owning worker's worktree, resolved via the conductor's `/api/instances`), and **cross-project epics** (slug guard, lock key, and the board-level `plans/` dir a no-owning-project epic needs).
- [architecture/gui-seam-contract.md](architecture/gui-seam-contract.md) — the web GUI's route→`board.js` map, envelope pass-through, `GUI_ACTOR`, read-only logbook/acceptance, the `meta` route.
- [architecture/card-epic-tool-split.md](architecture/card-epic-tool-split.md) — why card|epic logging is two tools (`log_card`/`log_epic`) and not a `oneOf` union; why `read_card_log`'s epic arm was deleted rather than kept; the accepted most-recent-first vs chronological ordering gap and `logbook_total` as its compensation; the deferred generic object-ref grammar and its revisit trigger.
- [architecture/cross-instance-sync.md](architecture/cross-instance-sync.md) — two-click one-way pull; hidden `uid`/`updated`/`node` stamp; deterministic legacy-uid backfill (why shared-lineage matches); LWW + display-id reassignment; depends_on translation; epic sync (slug-as-identity, NOT uid; kind-conflict skip+log; epics-before-cards; an epic's plan link + logbook ride whole-epic LWW, and the backfill hazard that makes serialize-without-parse destroy them); no-auth trust model.
