# Gotcha: a lookup keyed by caller or peer input must be an own-key lookup

A plain object literal inherits `Object.prototype`, so `map[name]` with a caller-chosen `name`
answers for keys nobody put there: `constructor`, `toString`, `hasOwnProperty`, `valueOf`,
`__proto__`. `name in map` has the same hole. Every one of those inherited values is truthy, and
most are functions, so a "does this key exist" check by truthiness or `in` lets them through.

What an inherited key does here without the guard, at two sites:
- `POST /api/mcp` with `tool: "constructor"` dispatches `Object(args)` as a tool and echoes the
  caller's arguments back as `{result}`. A body nested deeper than `JSON.stringify` can recurse
  then throws from the response write, outside every catch, and the unhandled rejection ends the
  process. Every surface shares that process, so one unauthenticated request takes the board down.
- A `constructor:x.md` plan link passes a `scheme in BASE_DIR` check, so `planBaseDir` calls
  `Object(project)` and `path.resolve` throws on the resulting `String` object — out of
  `update_card`'s lock on set, and out of `read_card` for a stored link a peer synced.

**Rule:** a map indexed by request, MCP or sync-peer input is read with `Object.hasOwn(map, key)`
first, never by truthiness and never with `in`. Sites today:

| map | module | keyed by |
|---|---|---|
| `handlers` | `src/mcp.js` | the MCP envelope's `tool` |
| `RAW_TEXT` | `src/mcp.js` | the same `tool` |
| `BASE_DIR` | `src/planLink.js` | a plan link's scheme, from a caller's `plan` or a stored (possibly synced) link |

`Map` and `Set` lookups (`.has`/`.get`) are already own-key only and need nothing. A
`Object.create(null)` map would also be safe, but nothing here uses one; keep the `hasOwn` guard as
the one idiom.

**Backstop:** `src/routes.js`'s `/mcp` route catches a throw from the response write and answers
`500 {error}` while headers are unsent. With own-key dispatch in place no input reaches it (every
tool result is built by board.js, never shaped by the caller), so removing it is a waived mutation
survivor — see `harness/mutation/README.md`.
