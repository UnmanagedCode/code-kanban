# Refusals name the valid set — derived from what the check reads

Owner rule: params stay strict (no aliases, fuzzy matching or inferred defaults), and **every
refusal names exactly what is valid**. The corollary that keeps the second half honest: the list
in a refusal's reason is **derived from the same source the check reads**, never a second copy.
A hand-written list would drift from the check and name a move that fails.

| Refusal | Check reads | Reason lists (`src/board.js`) |
|---|---|---|
| `move_card` illegal pair / same-state → `INVALID_STATE` | `ALLOWED_TRANSITIONS` | `legalTargets(from)` — a filter over that same Set, in its order |
| `move_card` unknown `to` → `INVALID_STATE` | `STATES` | `STATES` |
| `file_card` bad `category` → `INVALID_STATE` | `CATEGORIES` | `CATEGORIES` = `['triage', ...legalTargets('triage')]` — the intake lane plus triage's exits |
| `log_card` (`id`) wrong lane → `INVALID_STATE` | `LOGGABLE_STATES` | `LOGGABLE_STATES` |
| any `EPIC_UNKNOWN` (`readEpic`, `logEpic`, `fileCard`, `updateCard`) | `resolveEpic` / `epicVisibleIn` | `knownEpicSlugs(project)` via the one `epicUnknown` builder |

Gotchas:
- **`knownEpicSlugs` mirrors, it does not share.** `resolveEpic`/`epicVisibleIn` test one slug;
  `knownEpicSlugs` enumerates (own epics + member cross epics; cross only without `project`). If
  either resolver's scope rule changes, change `knownEpicSlugs` with it — the test
  `EPIC_UNKNOWN lists the known slugs for the scope, identically at every site` resolves every
  listed slug to catch a drift.
- **The card mutators' `; or create it with create_epic` hint (`createHint`) is withheld when a
  cross epic has the slug.** Following it would succeed — a project epic may share a non-member
  cross epic's slug — but that epic shadows the cross one and later makes adding the project to it
  refuse `EPIC_CONFLICT`. A same-slug epic in another project is project-scoped and never clashes,
  so it does not suppress the hint.
- **The manifest is static JSON**, so its copies (`file_card.category.enum`, `read_epic.logTail`
  default) cannot derive; `tests/pluginManifest.test.mjs` pins each to its constant instead.
- **The GUI** derives move targets from `/api/board/meta` (the same `ALLOWED_TRANSITIONS`), not
  from `legalTargets` — see [[gui-seam-contract]].
- **No structured `legal` field on the refusal.** The reason text is what callers (models) read;
  a machine-readable field has no consumer yet (YAGNI). Tests parse the text where they need the set.
- `move_card`'s manifest description still carries the transition table: the refusal is the
  recovery channel, the table prevents the failed call in the first place.
