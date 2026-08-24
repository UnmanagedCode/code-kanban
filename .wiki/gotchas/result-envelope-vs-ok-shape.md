# Gotcha: two nested result shapes — `{result}` vs `{ok}`

There are **two** layers and it's easy to conflate them:

1. **Wire envelope** (host contract): the plugin replies HTTP 200 with `{result:<any>}` or
   `{error:"msg"}`. The conductor's bridge treats `body.error != null` as a **tool failure it
   surfaces as a thrown MCP error**.
2. **Domain payload** (our brief): `board.js` functions **return** `{ok:true,…}` or
   `{ok:false, code, reason}` and **never throw** for a domain outcome.

The domain payload rides **inside** the envelope's `{result}`. So a refusal is
`{ result: { ok:false, code:"PROJECT_UNKNOWN", … } }` at HTTP 200 — deliberately **not**
`{error}`. Why: a refusal (unknown project, illegal transition) is a normal result the model
should see and reason about, not a transport error.

`{error}` is reserved for a malformed envelope (missing/unknown `tool`) or an unexpected
exception (`src/mcp.js`). If you ever make `board.js` throw for a refusal, it becomes an
`{error}` and the conductor will treat it as a failure — don't.

## A third shape: `{meta, text}` — raw, unescaped text blocks

The host's bridge also accepts `{meta, text}` **instead of** `{result}` on success (`text` wins if
both are sent): it emits `meta` as one compact-JSON content block plus each `text` as a **raw,
unescaped** block after it, rather than JSON-escaping a multi-KB document into one line. Evidence,
not folklore: code-conductor `src/plugins/mcpBridge.ts` (the `rec.text !== undefined` branch) →
`src/mcp/content.ts`'s `textPayload`.

**Every read** uses it now (2026-0023 added `list_tasks`/`list_epics` to the set 2026-0010 started):
`read_card` (card body, then `plan_body` when `includePlan` read a **non-empty** file — an empty
body emits no block, and `docs/protocol.md` has the full key-by-key outcome table), `read_card_log`
(logbook entries), `read_epic` (up to three blocks: `epic.goal`, the logbook as a `- ` list, then `plan_body` —
each omitted when empty), `list_cards` (a lane-grouped text listing, rendered by
`src/listRender.js`), `list_epics` (an epic-roster text listing). Only the **mutators** stay on
`{result}`. The rule that decides this — prose/document, or a listing that is the tool's whole
payload, → text block; anything a caller branches on (scalars, flags, and the counts describing the
listing as a whole) → the JSON block — and the per-tool block order live in `docs/protocol.md`; the
mechanism is `RAW_TEXT` + `shapeBody` in `src/mcp.js`. One exception: `read_epic`'s `cards` stays
JSON (a secondary field of a card-detail read, not the tool's own payload).

**New gotcha (2026-0023): `list_cards`' MCP default differs from `board.listCards`'s.** The MCP
surface hides the `done` lane by default (`state:'done'` or `includeDone:true` to see it); the HTTP
route (`GET /api/board/:project/cards`, used by the GUI) has no such default — it always returns
every lane `board.listCards` matches. This is deliberate (an MCP-only presentation default, per
`docs/architecture.md`), but it means the two surfaces legitimately disagree about what the same
`{project}` call returns.

Two consequences: a tool on this path has **no `result` key** at all, so anything reading
`body.result` must handle its absence — and it is now the *normal* path for all five reads, not a
conditional one (`read_card` always emits a card body, and `list_cards`/`list_epics` always emit at
least the header line even on an empty/all-hidden board, so none of the three has a `{result}`
fallback left; only `read_card_log`/`read_epic` can still emit **zero** text blocks, on an empty
logbook or a goal-less epic); and the channel is **MCP-only** — the GUI's HTTP routes bypass
`mcp.js` and keep reading `goal`/`logbook`/`plan_body` as plain fields, and (for `list_cards`/
`list_epics`) `cards`/`epics` as plain JSON arrays with no default hide.

Gotcha inside the gotcha: the card body is **re-rendered** from the card object
(`cardfile.serializeBody`), never passed through from the file. Reading the file would silently
ignore `logTail` and hidden-field stripping, so the text block would describe a different card than
the JSON block. `serialize` is defined as frontmatter + `serializeBody` for that reason — one
renderer, pinned by a test in `tests/cardfile.test.mjs`.
