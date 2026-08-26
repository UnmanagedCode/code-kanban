# `update_card`'s verbatim fields: which land unchecked, and what each wrong type does

`update_card` splits `fields` in two. `UPDATABLE` (`src/board.js:719`) lists every accepted key;
`PRE_RESOLVED` (`src/board.js:723`) lists the ones with their own resolver above the loop. Everything
in the difference is assigned **verbatim** by the generic loop at `src/board.js:793` — that verbatim
set is `title`, `goal`, `epic`, `priority`. A field in that set gets exactly the validation someone
remembered to write into the prologue; the loop itself checks nothing.

## What a wrong type does on disk, per field

- **`goal`** — reaches `cardfile.serializeBody`'s `(task.goal ?? '').trim()` (`src/cardfile.js:67`)
  and throws a `TypeError` **from inside the file lock**. That breaks the invariant stated at
  `src/routes.js:25` — board.js never throws for a domain outcome — so over HTTP it became a 500
  rather than an `{ok:false}` refusal.
- **`title`** — does not throw. `cardfile.serialize`'s `` `title: ${task.title ?? ''}` ``
  (`src/cardfile.js:41`) **silently stringifies** it onto a one-line frontmatter key, so `42` lands
  as the string `"42"`; `null` and `''` land a card with **no title at all** — a state `file_card`
  refuses outright.

Both are now refused by `checkTitle` (`src/board.js:248`) and `checkGoal` (`src/board.js:257`),
which `fileCard` calls too, so the refusal wording has one home and the two mutators cannot drift.

## The ordering rule before you add another field validator

`resolvePlanForSet` (`src/board.js:762`) is the **only** prologue step with a side effect: an
absolute `fields.plan` is *copied* into `plans/<id>.md`. Everything else up there is pure, and `task`
is an in-memory parse, so a refusal persists nothing regardless of where it sits. That makes the
ingest the only observable discriminator between "validates early" and "validates late" — a new
validator belongs **above** that call, and a test can pin the ordering by asserting no plan file was
ingested (see `tests/board.test.mjs`'s "refusal precedes every other resolution step").

Two known gaps in this same prologue are tracked as board cards `2026-0032` and `2026-0033`.
