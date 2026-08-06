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

Only `read_task` uses it, and only when `includePlan` actually read a plan body (`shapeBody` in
`src/mcp.js`). Two consequences: a tool on this path has **no `result` key** at all, so anything
reading `body.result` must handle its absence; and the channel is **MCP-only** — the GUI's HTTP
routes bypass `mcp.js` and keep reading `plan_body` as a plain field.
