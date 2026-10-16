# Architecture — internals

## Process model

An out-of-process HTTP server the conductor spawns via `npm start` (`server.js`), listening on
the injected `PORT`. It reaches the host only through injected env vars and the per-call MCP
envelope — it **never imports host modules** (they run in a different process).

Env this plugin reads: `PORT`, `HOST` (`server.js`), `PROJECTS_ROOT` and `CLAUDE_CONFIG_DIR` (the
Claude plans dir, an ingest root — `src/paths.js`), `CONDUCTOR_URL` (project validation,
`src/projects.js`). The host also injects
`CONDUCTOR_PROJECT_DIR` and `CONDUCTOR_PLUGIN_ID`, which this plugin does not currently use.

## Components

| Module | Responsibility |
|--------|----------------|
| `src/board.js` | **Single source of truth** — all board logic (transitions, id assignment, validation, log stamping, refusal codes). The GUI seam. Exports `ALLOWED_TRANSITIONS` read-only for the GUI's legal-move rendering. |
| `src/store.js` | File store: state dirs, atomic writes, moves, id sequence, epic files. **No git.** |
| `src/cardfile.js` | Card markdown ⇄ object (frontmatter + Goal/Acceptance/Logbook). |
| `src/paths.js` | Resolve `PROJECTS_ROOT` → `.conduct/kanban/...` paths (incl. each scheme's plan base dir). Ordered `STATES`. |
| `src/planLink.js` | Plan-link grammar (`board:`/`repo:`/bare) + the one containment guard, and `classifyPlanInput` — pointer vs **ingest** (a bare absolute input) discrimination. Pure — no fs; `board.js` owns stat-ing, the copy and every refusal shape. |
| `src/projects.js` | `validateProject` — shape check + live list via `CONDUCTOR_URL/api/projects` (scan fallback standalone). `listProjects` — same source, for the GUI selector. |
| `src/mutex.js` | Per-project async mutex — the one serialized write path. |
| `src/mcp.js` | Thin tool dispatch → `board.js`; MCP envelope. Also owns two MCP-only presentation defaults: hiding `done` from `list_cards` and rendering listings/prose as raw text blocks (`src/listRender.js`) — neither reaches the GUI. |
| `src/listRender.js` | Pure text renderers for `list_cards`/`list_epics`'s raw-text blocks. No imports beyond `STATES`; never sorts (renders `board.js`'s pre-sorted order as-is). |
| `src/routes.js` | Express router: `/api/health` + `/api/mcp` + the GUI's `/api/projects`, `/api/board/*`, `/api/epics*`, `/api/sync/*` routes. |
| `server.js` | The app: CSP + `nosniff` on every response, the API router, the built UI from `frontend/dist` (503 while unbuilt), plain-text 404 and error handlers; `createServer({distDir})`, `start()`, listen wiring. |
| `frontend/` | The web GUI: React + Vite + Tailwind v4 + Radix components, built to `frontend/dist` on `npm install`. See GUI integration seam. |

Thin surfaces (`mcp.js`, the GUI routes) call `board.js`; they never duplicate logic or call each
other. The GUI's additions to `board.js`/`projects.js` are **export-only** — `ALLOWED_TRANSITIONS`
and `listProjects` are read out; no service-layer logic changed. An MCP-only **presentation
default** (hiding `done` from `list_cards`, rendering a listing as text) is not board logic and
deliberately does not reach the GUI — `board.listCards`'s own default (every lane) is unchanged, so
the two surfaces legitimately disagree about what the same call returns.

## On-disk state

Board DATA lives in the conductor's tree, not this repo:

```
<PROJECTS_ROOT>/.conduct/kanban/
  epics/<slug>.md                              # CROSS-project epic: frontmatter projects:[…],
                                               #   plan?, ## Goal, ## Logbook
  plans/<rel>                                  # BOARD-LEVEL base for a CROSS-project epic's
                                               #   `board:` link — it has no owning project
                                               #   (paths.js boardPlansDir, a sibling of
                                               #   crossEpicsDir for the same reason);
                                               #   plans/epic-<slug>.md is its INGEST destination
  projects/<project>/
    triage/ backlog/ todo/ in-progress/ done/  # one <id>.md per card
    epics/<slug>.md                            # project-scoped epic: plan?, ## Goal, ## Logbook
    plans/<rel>                                # base for a card's OR a project-scoped epic's
                                               #   `board:` plan link; plans/<id>.md and
                                               #   plans/epic-<slug>.md are the INGEST
                                               #   destinations (an absolute `plan` input is
                                               #   copied there by board.js's ingestPlanFile,
                                               #   which also creates plans/ if the project
                                               #   predates store.ensureProjectDirs). The
                                               #   `epic-` prefix is load-bearing: SLUG_RE
                                               #   admits a card-id-shaped slug, so an
                                               #   unprefixed name would overwrite that card's
                                               #   own plan file.
```

- **No git writes from the plugin** (decision — see `.wiki/architecture/file-store-layout.md`).
  Moves are plain fs (write new dir + unlink old); writes are tmp-file + `rename` (atomic).
  Per-card history lives in the Logbook; git snapshotting of `.conduct` is the conductor's job.
- **IDs**: `${year}-${NNNN}`, where `NNNN` is a project-wide monotonic sequence
  (`max existing + 1`, does **not** reset on year rollover). Assigned inside the project mutex.
  Sequence numbers are **BigInt** end to end (`store.idFloor`/`nextId`/`formatId`,
  `board.trailingIdNumber`, `mergeProject`'s allocator): past 2^53 a float `+ 1` returns the same
  number, which re-mints an existing id and never terminates the sync allocator.
- **Priority: legacy tolerance instead of a migration.** `priority` moved from an integer ladder
  to `src/priority.js`'s `CRITICAL|HIGH|MEDIUM|LOW` plus a first-class unset state, and no migration
  script was written.
  `cardfile.parse` coerces tolerantly (`1→CRITICAL, 2→HIGH, 3→MEDIUM, 4→LOW, 5→LOW`; **anything
  else, including `0`, a missing key and an unknown word → unset (`null`)**) and never throws or
  drops a card, so a loaded legacy card already holds its true state in memory and the first write
  of any kind persists the new vocabulary; `cardfile.serialize` applies the same coercion as a guard
  on card objects that never came through `parse`, and **omits the frontmatter key entirely** when
  the card is unset. `0` maps to unset rather than to a level precisely because `0` meant "never
  judged": all 166 pre-existing cards hold it, and mapping it to `MEDIUM` would invent that many
  judgements. Live caller input is validated **strictly**
  instead (`INVALID_STATE`) — the two rules and the mixed-version sync hazard are in
  `.wiki/gotchas/priority-legacy-tolerance.md`.
- **The `task` → `card` rename carried no store migration.** The on-disk format never held the
  noun: `src/paths.js` was not edited, and `src/cardfile.js`'s `SCALAR_KEYS`, `serialize` and
  `parse` are byte-identical across the rename. So a board written by an older build reads here,
  a board written here reads on an older build, and `/api/sync/export` interoperates with an
  un-renamed peer. Only live MCP callers break, deliberately: a session holding the pre-rename
  tool registry gets `unknown tool: file_task` until it refreshes.

- **Epic rollups** are never stored — recomputed by scanning cards on each read. A cross-project
  epic aggregates the scan across every project in its frontmatter `projects:[…]` list.
  `countStates` (`src/board.js`) is the one counter behind `read_epic` and `list_epics`.
- **Epic order** (`list_epics`) is computed on read by `compareEpics` (`src/board.js`, test seam
  `_compareEpics`): active before completed, then last activity (max of epic + member-card
  `updated ?? created`) descending, then slug. **No migration** — the read-time `?? created`
  fallback gives legacy files the value sync's backfill would persist. `listEpics` memoizes each
  project's `listCards` for the call. See `.wiki/architecture/epic-ordering.md`.
- **Cross-project epics** live in the top-level `epics/` dir (above `projects/`) and join cards by
  the same `epic:<slug>` field. A slug can't be both a cross-project epic and a per-project epic in
  one of its members (`createEpic` refuses `EPIC_CONFLICT` in both orders), so a card's epic slug is
  unambiguous. Their writes serialize on a dedicated `withLock(' cross-epics')` key — distinct from
  every project name — so the per-project single-writer invariant is untouched.

## Cross-instance sync

Sync one board with another instance on a different machine, reachable at a code-hub-forwarded
URL (no git). **Two-click, one-way pull per click**: each click pulls the peer's FULL board dump
for a scope and merges it in; converging both machines means clicking Sync on each side. The merge
itself is grow-only: it unions by `uid` and never deletes a card it doesn't recognize. `delete_card`
(a plain hard delete, not a sync-aware tombstone) is a real gap this leaves: a card deleted on one
machine can reappear the next time that machine pulls from a peer that still holds it. Accepted for
now (YAGNI — no caller needs cross-machine delete propagation); revisit if that changes. A second,
smaller gap of the same kind: a card's `plan` **link** is ordinary frontmatter and rides
export/pull under whole-card LWW like `owner`/`commit`, but plan **bodies** are not shipped by
`exportBoard`/`syncPull`, so a synced card can carry a dead link. It degrades — `read_card` returns
`plan_missing`, `delete_card`'s unlink is a no-op, the GUI shows "(file not found)", and re-setting
that same link on this machine refuses `PLAN_UNKNOWN` — but never crashes. Also accepted (YAGNI);
not fixed. Plan **ingest** (an absolute `plan` input copied to `plans/<id>.md`) makes `board:` the
common scheme, so this gap is hit more often, not less: a pulled card carries a dead `board:` link
whose body never shipped. **Epic plan bodies inherit exactly this gap**, board-level `plans/` dir
included: an epic's `plan` link is a frontmatter scalar and ships, its body does not, and
`read_epic` degrades to `plan_missing: true` rather than refusing. Shipping bodies for epics but
not cards would be incoherent, and no caller needs it. The epic **logbook**, by contrast, lives
*inside* the epic record, so it ships automatically — but under **whole-epic LWW, which means the
losing side's entries are lost, not merged**, exactly as for a card's logbook. Details + rationale:
`.wiki/architecture/cross-instance-sync.md`, `.wiki/gotchas/plan-link-and-sync-gap.md`.

- **Hidden identity.** Cards carry three sync-only frontmatter fields (`src/cardfile.js`):
  `uid` (the true match key — random `crypto.randomUUID` for new cards), `updated` (UTC ISO-8601
  version stamp, bumped by **every** mutator via `board.js`'s `touch()`), and `node` (the machine
  that wrote this version — the LWW tiebreak). `uid`/`node` are stripped from every MCP/GUI read
  (`board.readCard`'s `stripHidden`; `summary()` never included them); `GET /api/sync/export` is
  the sole exposure. The short `${year}-${NNNN}` display id stays the MCP handle and never grows.
- **Node id**: a per-machine id minted once at `<kanbanRoot>/.node-id` (`src/nodeId.js`).
- **Merge** (`board.syncPull` → `mergeProject`, inside the same per-project `withLock`): union by
  `uid`. New peer uid → copied in, keeping its display id if free, else **reassigned** the next
  free local id (`uid` untouched — solves two machines minting the same `2026-NNNN` for different
  cards). Same uid on both → whole-card **last-edit-wins** (later `updated`, tiebreak higher
  `node`), keeping the local display id. `depends_on` (display-id sugar) is translated
  remote-id → uid → local-id from the pulled set; unresolvable entries are dropped and reported.
- **Migration**: legacy cards (no `uid`) are backfilled lazily at export/pull time under the lock.
  `uid` is **deterministic** — `deriveUid(project, id, created)` — so two machines holding the
  same shared-lineage legacy card derive the identical uid and union instead of duplicating.
- **Epics sync too** (`exportBoard` carries `projectEpics`/`crossEpics`; `syncPull` merges them
  BEFORE cards, so a card's `epic:` resolves against fresh epics). Epics match by **slug** (project
  epic keyed by `(project,slug)`, cross by `slug`) — NOT uid: the slug is human-chosen, addressable
  identity that cards reference, so it is never reassigned and `card.epic` is kept verbatim (never
  translated, and can never mispoint). Union by slug + whole-epic last-edit-wins (`updated`, tiebreak
  `node`; no uid). Legacy epics get `updated = created` backfilled so shared slugs match. A
  **kind conflict** (a slug that is a project epic on one side, cross-project on the other — the
  state `createEpic`'s `EPIC_CONFLICT` guard forbids) is **skipped and logged** in
  `summary.epicConflicts`, never merged and never deleted (grow-only). Cross epics merge under
  `CROSS_LOCK`, project epics under the project lock. A single-project export carries the project's
  own epics plus every cross epic covering it — exactly the set its cards can reference. `updated`/
  `node` are hidden from `read_epic`/`list_epics` (their responses are built from a field whitelist);
  `/api/sync/export` is the sole exposure.
- **Scope**: `project` (the current project) or `all` (every live project from `listProjects`).
  A peer project not present locally is skipped and reported (never auto-created).
- **Trust**: no auth — possession of the code-hub URL is the capability (the whole board API is
  already exposed by forwarding). The pull runs backend-to-backend to dodge browser CORS; the
  dialog shows THIS board's URL from `window.location` (the backend can't know its forwarded URL).

## Trust: what an unauthenticated caller can read through plans

Every route and tool is unauthenticated (`/api/mcp` included), so a plan read is bounded by what
the server will copy in or point at, not by who asks. `read_card` / `read_epic` with
`includePlan` return a plan body only from a file that passed one of these:
- **Ingest** (an absolute `plan`, `ingestPlanFile`): a regular `.md` file of at most 1 MiB whose
  realpath is under the Claude plans dir (`paths.claudePlansDir`) or `PROJECTS_ROOT` — copied into
  the board, then read from the copy. Anything else is `PLAN_SOURCE_DENIED`, and a path outside
  both roots is denied before any fs access, so the refusal reveals nothing about it.
- **Pointer** (`board:` / `repo:`, `safePlanFile`): a regular `.md` file (by realpath) whose
  realpath stays inside its own base — the record's `plans/` dir, or the project's base checkout —
  on set and again on every read, so a stored link a peer synced is held to the same rule.

**Readable:** any `.md` file of at most 1 MiB under either ingest root — the conductor's plans,
any worktree or checkout, and the board's own files. **Not readable:** anything outside both
roots, a symlink resolving out of them, a non-`.md` file (`.env`, keys), a FIFO or device, and
anything over the cap. See `.wiki/gotchas/plan-link-and-sync-gap.md` for the decision.

## GUI integration seam

The web GUI runs **in this process**. `server.js` mounts the API router at `/api` first, so `/api/*`
is never shadowed by a static file, then serves the built UI from `frontend/dist` at the manifest's
`frontend.path` (`/`). The GUI's routes (in `src/routes.js`) are a thin 1:1 delegate to `board.js`:
each calls the matching function and passes its `{ok}` envelope through as the HTTP body, so GUI
requests and MCP-tool calls serialize on the **same** in-process mutex — one writer. `board.js`'s
function interface (the `{ok}` / `{ok:false,code,reason}` return contract) remains the documented
seam. Route map and harness hooks: [.wiki/architecture/gui-seam-contract.md](../.wiki/architecture/gui-seam-contract.md).

GUI mutations are attributed to the constant `GUI_ACTOR = 'gui'` (`src/routes.js`) — the GUI has
no human identity, so `'gui'` is the honest logbook actor. `board.js` clears `owner` on any
non-`in-progress` move regardless, so passing `GUI_ACTOR` on every move only stamps the move's
log line (and in-progress ownership); it never leaves a stuck owner.

### Build and serving

- `npm install` runs `prepare` = `vite build --config frontend/vite.config.ts`, writing
  `frontend/dist/` (gitignored): `index.html`, `theme-init.js`, `assets/*`. `npm run dev` serves the
  source with the API proxied to `PLUGIN_BACKEND` (default `http://127.0.0.1:7100`);
  `npm run typecheck` is `tsc -p frontend`.
- `createServer({distDir})` (`server.js`), in middleware order:
  1. `Content-Security-Policy: CSP` and `X-Content-Type-Options: nosniff` on every response;
  2. `/api` → `buildRoutes()`;
  3. any path whose decoded form ends `.map`, case-insensitively → 404 (`express.static` decodes
     before its lookup, so `%2Emap` is a `.map` too; a malformed escape cannot be decoded and falls through to the terminal 404);
  4. `express.static(distDir)` when `distDir/index.html` exists; otherwise one
     `UI not built: <entry> is missing — run npm install` log line and a `text/plain` 503 for every
     non-`/api` request;
  5. terminal `text/plain` 404 `Not found` — no SPA fallback, so `/pluginBridge.js` and
     `/pluginTheme.css` 404 standalone;
  6. error handler: `text/plain`, client statuses kept, 500 → `Internal error`, logged.
- `distDir` defaults to `frontend/dist`; tests pass a fixture.
- Asset URLs are relative (`base: './'`), so the page works at `/` standalone and under
  `/plugins/code-kanban/` in code-conductor; `harness/playwright/snap-embedded.mjs` drives the latter.

### `frontend/src` layout

| Path | Holds |
|---|---|
| `lib/board.ts`, `lib/forms.ts`, `lib/api.ts`, `lib/persist.ts`, `lib/acceptanceEdit.ts` | Every UI decision as pure data: lane filtering, rollup pills, select options, request bodies, URL builders, the sync summary, the one `fetch` (`api`), the one `localStorage` user (`persist`). No DOM/React imports, erasable TS, `.ts`-suffixed relative imports — `node:test` imports them directly |
| `lib/utils.ts`, `lib/modalFocus.ts`, `lib/textEntry.ts`, `components/ui/*` | Copied from code-conductor's `web/src`, one file per component used |
| `hooks/useBoard.ts`, `hooks/useStatus.ts`, `hooks/useLatest.ts` | Board lists per project (stale responses dropped by a request sequence), the status line (`ok` clears after 2.5 s), a closing dialog's last payload |
| `components/*.tsx`, `App.tsx` | Toolbar, status line, board/lanes/tiles, epics pane, the five dialogs |
| `index.css`, `cc-theme-fallback.css`, `public/theme-init.js` | Tailwind + cc's `@theme inline`, the standalone token snapshot, OS-theme follow ([.wiki/architecture/host-theme.md](../.wiki/architecture/host-theme.md)) |

Lane scroll offsets survive every reload because lanes are keyed by state and stay mounted; only a
project switch shows placeholders ([.wiki/gotchas/lane-scroll-container.md](../.wiki/gotchas/lane-scroll-container.md)).

### CSP

`CSP` (exported by `server.js`): `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`.
`'unsafe-inline'` styles exist only for the Radix Dialog's injected scroll-lock `<style>`; content
never reaches a `style` attribute or element. Directive reasons: [protocol.md](protocol.md) → UI
serving and response headers.

### Divergences from code-conductor's plugin-UI reference setup

| | Here | Why |
|---|---|---|
| D1 | `engines.node >=22.18` (reference: `>=22.12`) | `node:test` imports the pure `lib/*.ts` through Node's built-in type stripping, unflagged from 22.18 |
| D2 | No vitest / happy-dom / testing-library | The repo's built-in-runner rule; component behaviour is proven by the Playwright harness |
| D3 | No sonner | The status line stays an inline `role="status"` live region; its strings are part of the harness contract |
| D4 | Express kept; 404 is `text/plain` | The backend already is Express; matches the reference's Express snippet |

### Verifying embedded

The harness boots its own servers for standalone runs. For the embedded case, against a scratch
code-conductor (never your own):
1. In a cc checkout: `PORT=<port> CC_ISOLATED_ROOT=$(mktemp -d) scripts/run-isolated.sh`.
2. `git clone` this branch to a scratch dir and `npm install` there; adopt **that clone**
   (`POST /api/projects/external {"name","path"}`) — adopting lets cc rewrite the checkout's
   `CONVENTIONS.md`.
3. `POST /api/plugins/rescan`, `POST /api/plugins/code-kanban/enable`, `POST /api/plugins/code-kanban/start`.
4. Seed through `http://127.0.0.1:<port>/plugins/code-kanban/api/board/<project>/…`.
5. `CC_URL=http://127.0.0.1:<port> PROJECT=<project> [PROJECT2=<other>] node harness/playwright/snap-embedded.mjs`.
6. `POST /api/plugins/code-kanban/stop` before stopping cc (plugin backends outlive it).

## Test patterns

`node:test` via `tests/run.mjs` (`npm test`). Each test isolates state in a fresh
`mkdtemp` set as `PROJECTS_ROOT` (`tests/_helpers.mjs`) and injects the live-project list via
`projects._setProjectFetcher` — no network, deterministic, order-independent.

Repo-wide gates read the prose and the code as text. Each pairs a liveness floor on what it read
with known-bad samples its own predicate must flag (and negative controls it must not), so a check
that is removed or inverted fails even though the clean tree still passes:
- `tests/docCitations.test.mjs` — every in-repo path the prose layers (`tests/_prose.mjs`) cite
  exists; `.ts`/`.tsx` cites included, code-conductor's own paths allowlisted, and nothing cited
  inside the gitignored `frontend/dist`.
- `tests/docFormat.test.mjs` — every markdown heading in the prose layers, outside fenced code, has
  a blank line or the file's start above it (`crowdedHeadings`).
- `tests/codeFormat.test.mjs` — no code file (`server.js`, `src/`, `tests/`, `harness/`, the
  frontend sources and config) holds two blank lines in a row (`doubledLines`).

Parsers of untrusted lines carry two suites ([.wiki/gotchas/linear-line-parsers.md](../.wiki/gotchas/linear-line-parsers.md)):
- `tests/lineParsers.test.mjs` — **differential**: each index-scanning helper against the regex it
  replaced, kept verbatim in the test as the oracle, over every short string of the branching
  alphabet behind shape prefixes plus a seeded sample.
- `tests/parserTiming.test.mjs` — **timing**: each pathological shape at 200 000 characters through
  a public entry point, run in a worker (`tests/_parserTimingWorker.mjs`) that is terminated at a
  2 s deadline, so a super-linear regression fails in about 2 s instead of hanging the file.

The UI has no DOM in `npm test`; its claims split three ways:
- **Pure decisions** — `tests/frontendLogic.test.mjs`, `tests/persist.test.mjs`,
  `tests/acceptanceEdit.test.mjs` import `frontend/src/lib/*.ts` directly (type stripping), with a
  stubbed `globalThis.fetch` for `api()`.
- **Source-scan guards** — `tests/frontendTheme.test.mjs` (host URL order, fallback coverage,
  token-only colours, no own theme toggle, the button-role rule) and
  `tests/frontendSafety.test.mjs` (no raw-HTML, eval, attribute-write, navigation, cookie or cross-frame sink, no expression `href`/`src`, no style by any
  route and in any letter case — attribute, `<style>`, any `style` key, bare or quoted (a type's
  included), a `.style` access —, no `/api` literal, one
  `fetch` site, one `localStorage` site, no JSX spread props in feature code) read the source as text through
  `tests/_sourceScan.mjs`'s brace- and string-aware JSX tag scanner. They read every script type
  Vite bundles (`UI_CODE_EXTS`: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`)
  plus CSS. A scan whose
  expected result is "no offenders" proves it can still detect, three ways: a liveness floor on
  what it read; known-bad samples, at least one per alternative of every pattern, each of which
  the scan's own check must flag (counted at the check); and a temp fixture tree that breaks every
  rule from a different script type, so a rule, an alternative or a file type the scan stops
  covering fails.
- **Serving** — `tests/server.test.mjs` against a fixture build (`createServer({distDir})`);
  `tests/dist.test.mjs` against the real `frontend/dist`, skipped when it is not built.
- **Everything rendered** (wiring, layout, focus, theme, console) — the Playwright harness:
  `harness/playwright/snap-gui.mjs`, `snap-sync.mjs`, `snap-theme.mjs` (each boots its own scratch
  server and sandbox root) and `snap-embedded.mjs` (a scratch code-conductor; see "Verifying
  embedded").
