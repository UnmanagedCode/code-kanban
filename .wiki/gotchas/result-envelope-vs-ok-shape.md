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
