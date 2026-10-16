# Gotcha: card, epic and sync parsers must stay linear on untrusted lines

Card and epic files hold text from HTTP bodies, MCP args, `log_card` entries and sync peers, and
`cardfile.parse` / `store.js`'s `parseEpicFile` run synchronously on the one thread that also
answers `/api/health`. A super-linear parse of one stored line hangs every later read of it, and
the host still shows the plugin `ready`.

## The trap: splitting on `\n` leaves three terminators inside a line

`text.split('\n')` keeps `\r`, U+2028 and U+2029 inside a line. `\s` matches all three; `.` matches
none. So a pattern with a whitespace quantifier followed by a `.`-only tail can match the run but
fail at the terminator, and the engine then retries every split of the run before giving up:

| Shape | Growth | Example line |
|---|---|---|
| `\s+(.+?)\s*$` | cubic | `"##" + spaces + "a\rb"` |
| `\s+(.*)$` | quadratic | `"-" + spaces + "a\rb"` |
| unanchored `x+$` | quadratic (rescans from every start) | `"/".repeat(N) + "a"` |
| unanchored `(\d+)\s*$` | quadratic | `"1".repeat(N) + "a"` |

`.trim()` before matching does not help: the terminator sits mid-line.

## The rule

- No quantifier followed by `(.*)` / `(.+?)` with a tail that can fail, and no unanchored
  `x+$`, over untrusted text. Scan by index instead.
- The index scanners are `parseSectionHeader`, `parseAcceptanceLine`, `parseLogbookLine`
  (`src/cardfile.js`; `parseEpicFile` imports the logbook one, so card and epic logbooks share a
  rule) and `stripTrailingSlashes`, `trailingIdNumber` (`src/board.js`).
- Each returns exactly what its regex captured. Two non-obvious edges they keep: a `## ` header
  whose remainder is all whitespace still matches, naming its last non-terminator character; and
  a capture that holds a terminator refuses the whole line (`.` would not reach end of line).
- `/\s/` and `String.prototype.trimEnd` use the same character set (WhiteSpace ∪ LineTerminator),
  so swapping one for the other keeps behaviour.

## The proof

- `tests/lineParsers.test.mjs`: differential. The original regexes are kept verbatim there as the
  oracle and compared on every short string over the branching alphabet, behind shape prefixes,
  plus a seeded sample.
- `tests/parserTiming.test.mjs`: each pathological shape at 200 000 characters through a public
  entry point (`cardfile.parse`, `store.readEpic`, `board.syncPull`, `trailingIdNumber`), in a
  worker terminated at a 2 s deadline. A reverted regex shows up as that deadline error within
  about 2 s, not as a hung suite.

Related: [[frontmatter-injection-via-one-line-keys]], [[acceptance-line-round-trip]].
