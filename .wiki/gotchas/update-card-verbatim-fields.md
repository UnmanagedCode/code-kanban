# `update_card`'s verbatim fields: which land unchecked, and what each wrong type does

`update_card` splits `fields` in two. `UPDATABLE` (`src/board.js:758`) lists every accepted key;
`PRE_RESOLVED` (`src/board.js:762`) lists the ones with their own resolver above the loop. Everything
in the difference is assigned **verbatim** by the generic loop at `src/board.js:837` — that verbatim
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

Both are now refused by `checkTitle` (`src/board.js:257`) and `checkGoal` (`src/board.js:269`),
which `fileCard` calls too, so the refusal wording has one home and the two mutators cannot drift.

- **`epic`** — two distinct failures, both silent. A **falsy-but-present** value (`0`, `false`,
  `''`, `NaN`, `undefined`) landed verbatim, and `cardfile.serialize` writes the key only when
  truthy (`src/cardfile.js:43`), so it was dropped on write and `cardfile.parse` read it back as
  `null` (`src/cardfile.js:81`) — an `{ok:true}` that silently **orphaned the card from its epic**.
  A **truthy non-string** was worse than a refusal: `epicVisibleIn` interpolates its slug into a
  path template (`src/store.js:175`), so `['ep']` *matched* the real epic `ep` and the array was
  stored on the card, and `Symbol()` threw a `TypeError` out of the lock. Both closed by `checkEpic`
  (`src/board.js:288`), which `fileCard` calls too — same one-home rule.

## The ordering rule before you add another field validator

`resolvePlanForSet` (`src/board.js:806`) is the **only** prologue step with a side effect: an
absolute `fields.plan` is *copied* into `plans/<id>.md`. Everything else up there is pure, and `task`
is an in-memory parse, so a refusal persists nothing regardless of where it sits. That makes the
ingest the only observable discriminator between "validates early" and "validates late" — a new
validator belongs **above** that call, and a test can pin the ordering by asserting no plan file was
ingested (see `tests/board.test.mjs`'s "refusal precedes every other resolution step").

The rule this family now establishes, and the one to copy for the next field: **in this prologue,
presence is `'<key>' in fields` — never truthiness.** `src/board.js:795` (`priority`) is the
reference idiom; the epic gate at `:785` was the last hold-out, and `2026-0032` closed it with
`checkEpic` — `null` is the clear sentinel (as for `plan`/`priority`/`acceptance`/`owner`), and
everything else must be a non-empty string. A side effect of the type check: a truthy non-string
`epic` moved from `EPIC_UNKNOWN` to `INVALID_STATE`. Slug *syntax* is still not re-checked at the
gate — a string slug containing `/` or `..` reaching `path.join` is card `2026-0036`.

`2026-0033` closed the title hole in the same prologue: `checkTitle` now also refuses a newline, because a `title` newline does not truncate but
injects sibling frontmatter keys — see [[frontmatter-injection-via-one-line-keys]] for the
per-key audit and the refuse-vs-sanitize rule.
