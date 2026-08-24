# Gotcha: an acceptance criterion is one line — newline and empty text vanish

A criterion is stored as **one** `- [ ] <text>` line in the card body
(`cardfile.serializeBody`, `src/cardfile.js:62-63`), and `cardfile.parse` **trims each line**
before matching it against the checkbox regex (`src/cardfile.js:115-118`). Two consequences that
are easy to miss because neither one throws or refuses at parse time:

- **A newline inside `text` silently truncates on the next read.** `serializeBody` writes the raw
  string after `- [ ] `, so `{text:'a\nb', done:false}` becomes two physical lines: `- [ ] a` and a
  bare continuation line `b`. `parse`'s per-line regex matches the first line and produces
  `{text:'a', done:false}` — the `b` line doesn't match `^-\s+\[...\]` and is silently dropped, not
  merged back in. `b` isn't in the Acceptance section on the next read at all.
- **Text that is empty after trimming vanishes entirely.** The parse regex requires `\s+` between
  the checkbox and the text, so a line like `- [ ] ` (or `- [ ]` with only whitespace after) never
  matches, and the criterion silently disappears from the parsed list — not an empty-string
  criterion, just gone.

## Why `update_card`'s acceptance validator refuses both

`update_card`'s `fields.acceptance` validator (`cleanAcceptanceText` in `src/board.js`, feeding
both `applyAcceptanceOps`'s `add`/`rename` ops and `replaceAcceptance`) refuses a newline-bearing or
empty-after-trim `text` with `INVALID_STATE` rather than writing it and letting the round-trip
silently eat it on the next read. The value it stores is always the **trimmed** text — trimming
happens before persistence, not as a read-time cleanup — so what's on disk matches what a caller
just set.

## `file_card` is knowingly asymmetric

`file_card`'s `acceptance: string[]` filing-time form (`src/board.js:286`) does **not** run through
this validator — it accepts any string, untrimmed, newline included. So `update_card` can refuse a
criterion that `file_card` happily accepted at filing time. This is intentional for 2026-0020 (the
owner is tracking the asymmetry separately, not fixing it here): the two input forms are deliberately
not unified — see `docs/protocol.md`'s `update_card` acceptance section for the full contract, and
[[flat-inputschema-constraint]] for how the nested op shape reaches the wire.
