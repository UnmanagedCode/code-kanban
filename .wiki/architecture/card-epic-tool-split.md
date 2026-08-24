# Decision: card|epic logging is two tools, not one union (card 2026-0027)

Merge `20e4f31` overloaded `log_progress` and `read_card_log` onto a card|epic union whose
exclusivity was enforced only in **sentences** ("mutually exclusive with `id`"). Card 2026-0027
split them: `log_card` / `log_epic`, and `read_card_log` (card) / `read_epic` (epic).

## Why not `oneOf`

The host rejects `oneOf` in a tool `inputSchema` outright — see
[[flat-inputschema-constraint]]. So the exclusivity could not be expressed in the schema at all
while the union stood; it had to be prose, and prose is a per-session system-prompt cost that no
validator enforces. Two tools with **disjoint `required[]`** (`log_card` → `["entry"]`,
`log_epic` → `["slug","entry"]`) make the same constraint structural and free.

The second reason is audience: a worker never logs to an epic, yet every worker session loaded the
epic-resolution prose. `conventions/board.md` is `scope: "conductor"`; workers load
`conventions/reporting.md`. The union made the worker pay for a conductor-only path.

## Why `read_card_log`'s epic arm was deleted, not kept

`board.readEpic` (`src/board.js`) already returns `epic.logbook` and already caps it with the same
slice-guard `read_card` uses; `src/mcp.js`'s `epicLogbook` extractor already renders it as a raw
text block. The arm was duplicate surface, and deleting it also restored
`required:["project","id"]`, which the union had dropped (so `read_card_log({})` had become
schema-legal).

Two deltas the deletion cost:

- **`total` was lost.** `read_card_log` returns it; `read_epic` did not, so a `logTail`'d read
  could not tell 5 entries from 50. **Fixed:** `read_epic` gained a top-level `logbook_total`,
  computed **before** the `logTail` slice. Top-level, not inside `epic`, because `epic` mirrors the
  stored record and `logbook_total` is not a record field — the same placement rule `plan_path`
  follows.
- **Ordering changed.** `read_card_log` is most-recent-first (`tail()` reverses); `read_epic`'s
  logbook is **chronological**. **Accepted, not fixed** — chronological order within a tail slice
  is visible in the output, so no fact is hidden. Recorded here so a reader doesn't re-derive it as
  a bug.

## Deferred: a generic object-reference grammar

A grammar like `card/<project>/<id>` / `epic/<slug>` as a single `ref` param, *instead of* separate
tools, was considered and **rejected**: a grammar must be documented wherever it is accepted
(recreating the duplication with a new subject), the worker-facing call site cannot reference a
conductor-scope convention, it trades JSON Schema validation for a parse-error code, and it would
be a half-migration across the manifest's tools.

**Revisit trigger:** 3+ addressable kinds across 4+ tools, all conductor-only.

## Naming

`log_progress` → `log_card` because every other tool is `<verb>_<subject>` and "progress" stops
distinguishing anything once two tools compete for the call site. `read_progress` → `read_card_log` (card **2026-0028**) for the same
reason, once the epic arm was gone: it names its subject, so the write/read pair for a card's
logbook is symmetric and structural. A bare `read_log` would have implied the epic arm this split
deliberately deleted — an epic's logbook is read through `read_epic`'s `epic.logbook` +
`logbook_total`, not a second log tool. Related: [[owner-from-caller-sessionid]], [[result-envelope-vs-ok-shape]].
