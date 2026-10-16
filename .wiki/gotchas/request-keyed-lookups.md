# Gotcha: a lookup keyed by caller or peer input must be an own-key lookup

A plain object literal inherits `Object.prototype`, so `map[name]` with a caller-chosen `name`
answers for keys nobody put there: `constructor`, `toString`, `hasOwnProperty`, `valueOf`,
`__proto__`. `name in map` has the same hole. Every one of those inherited values is truthy, and
most are functions, so a "does this key exist" check by truthiness or `in` lets them through.

What it did here: `POST /api/mcp` with `tool: "constructor"` dispatched `Object(args)` as a tool and
echoed the caller's arguments back as `{result}`. A body nested deeper than `JSON.stringify` can
recurse then threw from the response write, outside every catch, and the unhandled rejection ended
the process. Every surface shares that process, so one unauthenticated request took the board down.

**Rule:** a map indexed by request, MCP or sync-peer input is read with `Object.hasOwn(map, key)`
first, never by truthiness and never with `in`. Sites today:

| map | module | keyed by |
|---|---|---|
| `handlers` | `src/mcp.js` | the MCP envelope's `tool` |
| `RAW_TEXT` | `src/mcp.js` | the same `tool` |

`Map` and `Set` lookups (`.has`/`.get`) are already own-key only and need nothing. A
`Object.create(null)` map would also be safe, but nothing here uses one; keep the `hasOwn` guard as
the one idiom.

**Backstop:** `src/routes.js`'s `/mcp` route catches a throw from the response write and answers
`500 {error}` while headers are unsent. With own-key dispatch in place no input reaches it (every
tool result is built by board.js, never shaped by the caller), so removing it is a waived mutation
survivor — see `harness/mutation/README.md`.
