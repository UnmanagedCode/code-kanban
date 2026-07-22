# Decision: `board.js` is the single writer and the GUI seam

All board logic lives in `src/board.js` (transitions, id assignment, validation, log stamping,
refusal codes). Everything else is thin: `src/mcp.js` dispatches tools to it; the future web GUI
will import it directly. Nothing duplicates its logic.

## Single writer via one mutex

Every mutator runs inside `withLock(project, …)` (`src/mutex.js`) — a per-project promise chain.
That mutex is the **sole write path**, so scan-then-write sequences (id assignment, moves) are
race-free without any git or file-level locking. This is a firm invariant: adding a second
independent writer breaks it.

## Why same-process for the GUI (decided)

The secondary web GUI is served by **this plugin's own process** and imports `board.js`
directly, so GUI requests and MCP-tool calls serialize on the **same** in-process mutex — one
writer, trivially safe. We deliberately did **not** build an HTTP board API (YAGNI for a
secondary, local GUI).

**The documented seam for the GUI worker is `board.js`'s function interface** (the `{ok}` /
`{ok:false,code,reason}` return contract), not an HTTP contract.

## When option 2 (cross-process HTTP) would be justified

If the GUI ever needs to run as a **separate process**, do NOT let it import `board.js` and open
the files itself — two processes each with their own mutex instance would contend. Instead expose
`board.js` over a local HTTP board API on this server and have the GUI call that, preserving the
single-writer rule. Only take this on when a real cross-process need appears.
