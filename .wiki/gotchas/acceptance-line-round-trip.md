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

## Why both mutators refuse them

`cleanAcceptanceText` (`src/board.js`) is the one text validator. It feeds `update_card`'s
`add`/`rename` ops and `replace`, and `file_card`'s filing-time `acceptance: string[]` (via
`resolveAcceptanceForFile`) — so the two surfaces cannot disagree about what a criterion may
contain.

It refuses a newline-bearing or empty-after-trim `text` with `INVALID_STATE` rather than writing
it and letting the round-trip silently eat it on the next read. The value it stores is always the **trimmed** text — trimming
happens before persistence, not as a read-time cleanup — so what's on disk matches what a caller
just set.

## A wrong-shaped list is refused, never coerced

`acceptance` and `depends_on` are `string[]` at `file_card`, and `depends_on` is `string[]` at
`update_card`. A **present** value that is not an array, or an array holding a non-string item, is
`INVALID_STATE` naming the field (and the item's index) — never coerced to an empty list.
`undefined` and `null` both mean "not given". The refusal lands before the card is written, so it
consumes no id and leaves an existing card untouched. `resolveListForSet` /
`resolveAcceptanceForFile` / `resolveDependsOnForSet` in `src/board.js`; `resolveDependsOnForSet`
serves both mutators, so they cannot drift.

Coercing instead would discard the whole field while still returning `{ok:true, id}` — the caller
gets no signal and the card lands with an empty `## Acceptance` section, which is the failure this
refusal exists to prevent. A non-string ITEM is worse than it looks: `serializeBody` renders it
`- [ ] [object Object]`, which `parse` reads back as that literal string, so the wrong shape
survives as plausible data rather than as an obvious husk.

The CONTAINER shapes stay deliberately different: `string[]` at filing, `{ops:[…]}` /
`{replace:[…]}` / `null` at update. See `docs/protocol.md`'s `update_card` acceptance section, and
[[flat-inputschema-constraint]] for how the nested op shape reaches the wire.

The manifest's `{type:"array", items:{type:"string"}}` is **advisory**: the host does not enforce
it, and calls have reached `fileCard` with a non-array `acceptance`. Runtime validation is the only
gate.
