# Mutation-verification harness

Config for `code-mutant`'s `mutate.mjs` (sibling project `code-mutant/`), so a reviewer can run
`/code-mutant:prove` against this project. See `config.json` in this directory; `node
<path-to-code-mutant>/mutate.mjs --help` is the authoritative CLI reference.

## Config choices

- `runner: "node-test"` — `npm test` runs `node tests/run.mjs`, a thin wrapper that drives
  `node:test` via its public API and pipes the same `node:test/reporters` `spec` reporter used by
  `node --test`. Its captured output (summary counters, `✖ failing tests:` block, module-load
  failures reporting the file path as the test name) matched the `node-test` adapter's fixtures
  byte-for-byte, so no custom parser was needed.
- `isolation: "copy"` — the suite is pure in-process unit tests; each test opens its own
  `fs.mkdtemp(os.tmpdir())` board root (`tests/_helpers.mjs`), so it doesn't depend on this
  checkout's absolute path and is safe to run against a copied tree. (`harness/playwright/` is a
  separate, unrelated visual-verification gate — not part of `npm test` — so it doesn't factor into
  this choice.)
- `preserve: ["node_modules"]` — symlinked into the copy instead of duplicated.
- `baseBranch: "master"` — this project's real integration branch (`git remote show origin`: `HEAD
  branch: master`).

## Running

From this project's root:

```bash
node <path-to-code-mutant>/mutate.mjs baseline --copy
node <path-to-code-mutant>/mutate.mjs run --all --copy
node <path-to-code-mutant>/mutate.mjs validate
```

`baseline` must be green (and its canary `KILLED`) before any mutant verdict is trustworthy.
`--copy` is the default from `config.json`; pass `--in-place` to override for one invocation.

No mutant catalog or canary is checked in here — `.mutation/` (gitignored) is created per review
loop by the reviewer running `/code-mutant:prove`, not by this scaffold.

## Standing waivers (expected survivors)

No catalog is checked in, so a waiver can't be pre-annotated in a file the runner reads. Carry these
forward as `waived: { reason }` on the matching catalog entry (`mutants.schema.md`) — waived mutants
still run and report, but don't affect the exit code.

| mutant | site | why unkillable |
| --- | --- | --- |
| drop the self-copy guard | `ingestPlanFile`, `src/board.js` | With or without the guard, **nothing is written**: libuv opens the destination `O_WRONLY\|O_CREAT` (no `O_TRUNC`), compares `st_dev`/`st_ino` and returns success. Verified by `strace` on Node v24.18.0, Linux. |
| `source === dest` string compare instead of realpaths | same | Same reason — the string compare misses the symlink form, but the copy it then performs is still a no-op. |
| `epicLockKey` returns `t.project` for **every** kind (so a cross epic's writes take `withLock(undefined)` instead of `CROSS_LOCK`) | `epicLockKey`, `src/board.js` | Changing the key changes the exclusion domain of **every `withLock(CROSS_LOCK)` holder that read-modify-writes a cross-epic record** — `logEpic`, `createCrossEpic`, `exportBoard`'s cross backfill, and `syncPull`'s `mergeCrossEpics`. All four critical sections are **`await`-free**, so on Node's single thread none can interleave with another whatever key it holds, and every write stays atomic; the reachable orderings are all legal serial orders, so no deterministic test can distinguish them. Same argument `.wiki/architecture/file-store-layout.md` records for the slug guard's two-lock design. **Not dead code — do not delete the branch:** the two values differ semantically and are indistinguishable only while that invariant holds; the branch is what keeps `logEpic` in the same exclusion domain as the other three writers. **Re-test condition:** no `await` may appear inside ANY `withLock(CROSS_LOCK)` callback — the first one to appear makes this mutant killable and the code defective. (The only await-inside-a-lock in the codebase today is `moveCard`, on a per-project key, cards only.) *Waived by owner 2026-08-23; equivalence independently measured by mutation review round 2, not by the author.* |
| drop the `/mcp` route's try/catch around `mcp.handle` and the response write | `r.post('/mcp')`, `src/routes.js` | A backstop no input reaches: with `Object.hasOwn` dispatch in `src/mcp.js`, every `/mcp` body is built by board.js or is a fixed `{error}` string, so none carries caller-shaped depth and `res.json` cannot throw. `a deeply nested tool body cannot take the server down` (`tests/server.test.mjs`) stays green without it. **Re-test condition:** any tool result or envelope that can carry caller-shaped depth (an argument echoed back, a peer value passed through) makes this mutant killable by that test's shape. |
| drop `Object.hasOwn` from `shapeBody`'s `RAW_TEXT` lookup | `shapeBody`, `src/mcp.js` | `shapeBody` runs only after `handle` has admitted `tool` as an own key of `handlers`, and no handler name is an `Object.prototype` member, so the lookup never sees an inherited key. Kept so every request-keyed lookup reads the same way (`.wiki/gotchas/request-keyed-lookups.md`). **Re-test condition:** a tool whose name is an `Object.prototype` member, or a `shapeBody` caller that skips `handle`'s check. |

Waiver reason to record: *"owner 2026-08-11: guard kept as insurance against libuv's UNSPECIFIED
same-inode behaviour (node's fs.copyFile docs promise nothing about it) on an unrecoverable path —
the destination is the only copy of the plan. Behaviourally unobservable on Linux/libuv, so no test
can kill it. See .wiki/gotchas/plan-link-and-sync-gap.md."*

Everything else on that feature must die — notably: drop the `mkdirSync`; `renameSync` instead of
`copyFileSync`; name the destination from the source basename; skip the copy when the destination
exists; ingest a `board:`/`repo:` pointer; treat a bare relative path as an ingest; set `card.plan`
before the source is validated; write the card before the copy in `fileCard`.

The epic-level plan link + logbook (2026-0025) extends that list. `planFields`,
`resolvePlanForSet` and `ingestPlanFile` each serve **both record kinds** (card and epic), so mutate
**at each call site**, not only inside the shared helper — a per-call-site gap otherwise hides
behind a helper that looks covered. The call-site counts differ and matter: `planFields` has 2
(`readCard`, `readEpic`), `resolvePlanForSet` has **3** (`fileCard`, `updateCard`, and the epic
upsert — killing the `fileCard` destination mutant says nothing about `updateCard`), and
`ingestPlanFile` has **1**. `resolveDependsOnForSet` serves **both** mutators (`fileCard`,
`updateCard`) and `resolveListForSet` serves both list validators — mutate **at each call site**,
not only inside the shared helper. Killing `file_card`'s mutant says nothing about `update_card`'s.
The same discipline applies to the **project-scoped vs cross-project**
split, which is this feature's other recurring asymmetry: `createEpic`, the epic codecs, the sync
backfill and the merge each have two halves, and a pin on one half proves nothing about the other.
Named mutants that must die:

| mutant | killed by |
| --- | --- |
| drop `create_epic`'s preserve-on-omit branch (`goal ?? ''` unconditionally) | `create_epic re-upsert preserves an OMITTED goal…` + both route tests |
| test presence with `'goal' in args` instead of `goal !== undefined` | **only** `POST an epic twice without a goal PRESERVES it` and the cross-epic route test — `src/routes.js` is the sole caller that passes the key holding `undefined`, so no `tests/board.test.mjs` test can reach it |
| preserve `goal` but not `plan`, or drop `logbook` from the upsert write | `…preserves an OMITTED plan…` / `…preserves the epic's LOGBOOK…` |
| name the epic ingest destination `<slug>.md` | `an epic ingest cannot clobber a card's plan file when the slug looks like a card id` |
| resolve a null project to some default project dir (or a member's) | `a cross-project epic's plan lives in the BOARD-LEVEL plans/ dir, never a member's`, the `planLink` base test, `repo: on a CROSS-project epic…` |
| resolve a **project-scoped** epic against the board-level dir | `a project-scoped epic's board: link resolves under ITS project's plans/…` |
| compute `plan_path` inside the `includePlan` branch | `read_epic returns plan_path with AND without includePlan…` **and** the card-side `update_card sets a board: plan link…` — each path pins it independently |
| reintroduce a lane gate on the epic log path | `logging to an epic with ZERO cards succeeds…` |
| drop the `touch()` on the epic log write | `logging to an epic bumps its updated/node version stamp…` |
| serialize `plan`/`logbook` without parsing them back | **only** `exportBoard's identity backfill does not destroy a legacy epic's plan link and logbook` — the backfill read-then-rewrite is the sole path that exposes it |
| reorder `read_epic`'s extractors, or leave `logbook` in `meta` | `read_epic emits goal, logbook and plan_body as three ORDERED text blocks` |
| drop the `id`/`epic` mutual exclusion; always prefer the cross epic | `…with BOTH id and epic -> INVALID_STATE` / `epic logbook resolution precedence matches read_epic` |
| always echo `plan` in `create_epic`'s result — **from either writer**; the two have separate return statements | `create_epic reports the stored plan link ONLY when plan was in the call (project AND cross)` |
| drop `plan`/`logbook` parsing, reached via the **cross** backfill (`backfillCrossEpics`) | `exportBoard's identity backfill does not destroy a legacy epic's plan link and logbook` — the fixture hand-writes one legacy epic **per kind**; each half is the only pin for its own backfill function |
| stop resetting the parser's section at an unknown `## ` heading | `an unknown \`## \` section bleeds into neither the goal nor the logbook` |
| emit the owner line after `created:`; `projects: [a,b]` without the space | `the serialized epic file is byte-exact, for a project AND a cross epic` (parsed-result assertions cannot see either) |
| drop `parseEpicFile`'s `Array.isArray(epic.projects)` seed guard | `a project-scoped epic never adopts a stray \`projects:\` frontmatter line` — kind confusion here feeds `epicPlanScope`, so it decides which dir a plan resolves against |
| drop `normalizeRemoteEpic`, or **any one of its three clauses** (`goal`, `plan`, `logbook` — each guards a different serializer call: `.trim()`, the frontmatter line, `.map()`) | `a peer serving a malformed epic goal/plan/logbook is normalised, not fatal — and cards still merge` (exercises both merge paths in one dump) |
| drop `mergeCrossEpics`' members filter; keep it but move it AFTER the `< 2` length check; drop only its `store.isRecordName(p)` clause | `a cross epic with non-string members is filtered, not fatal — and the length check sees the filtered list`. Three distinct mutants, all killed by that one fixture: a non-string member throws in `path.join`; filtering after the length check lets a junk-padded list pass as long enough; and a blank member is invisible to any parsed-result assertion — `writeCrossEpic` emits the hole (`[alpha, , beta]`) and `parseEpicFile`'s `.filter(Boolean)` swallows it on re-read, so the test asserts the **file text** and the skip of an epic that is only long enough if blanks count |
| spread `projects` unconditionally into `readEpic`'s response (holding `undefined` on a project-scoped epic) | `epics: create, file under, rollup counts on read` — **not** the `read_epic returns plan_path…` envelope test. JSON drops an undefined value and the GUI never branches on presence, so only an explicit `'projects' in epic === false` sees it |
| `slice(length - logTail)` without the `Math.max(0, …)` clamp | the `logTail` tests in `read_epic`/`read_card` both assert `logTail` > length returns the WHOLE log |

## Request-input hardening: mutants that must die

Each row is one fix's mutant and the test that kills it. Where a fix is shared by several call
sites, the row says which ones to mutate separately.

| mutant | killed by |
| --- | --- |
| index `handlers` without `Object.hasOwn` in `mcp.handle` | `an Object.prototype key is an unknown tool` (`tests/mcp.test.mjs`) and `a deeply nested tool body cannot take the server down` (`tests/server.test.mjs`) |
| `scheme in BASE_DIR` instead of `Object.hasOwn(BASE_DIR, scheme)` in `parsePlanLink` | `planLink: an Object.prototype name is an unknown scheme` (`tests/planLink.test.mjs`); on the set path `update_card plan with a constructor: scheme -> INVALID_STATE`, on the read path `read_card with a stored constructor: plan link -> ok, plan_path null` (`tests/board.test.mjs`) |
| drop `ID_SHAPE.test(rc.id)` from `mergeProject`'s peer-card validation | `a peer card id that traverses out of the board is skipped; the sentinel is untouched` and the `zz-legacy` half of `a peer card id longer than 64, or not <year>-<number>, is skipped` (`tests/sync.test.mjs`) |
| drop the `PEER_ID_MAX` bound, or test `>=` instead of `>` | `a peer card id longer than 64, or not <year>-<number>, is skipped` — a 65-character id must skip and a 64-character one must merge |
| drop `isRecordName` from `findCardFile` (card reader) | `a traversing card id is CARD_UNKNOWN on every card path; the sentinel is byte-identical`, `update_card with a traversing id and an absolute plan -> CARD_UNKNOWN, nothing copied` (`tests/board.test.mjs`) and `GET a card by an encoded traversing id -> 200 CARD_UNKNOWN…` (`tests/routes.test.mjs`) — each reader guard is its own mutant: removing it reaches the throwing path builder, so the test sees a throw instead of the refusal |
| drop `isRecordName` from `epicExists` / `readEpic` (project-epic readers) | `a traversing epic slug on a card is EPIC_UNKNOWN and never stored` (the `epicExists` half) and the `(project)` cases of `a traversing epic slug is EPIC_UNKNOWN on read_epic and log_epic…` (`readEpic`) |
| drop `isRecordName` from `crossEpicExists` / `readCrossEpic` (cross-epic readers) | the create-hint assertion of `a traversing epic slug on a card is EPIC_UNKNOWN and never stored` (`crossEpicExists`) and the `(cross)` cases of `a traversing epic slug is EPIC_UNKNOWN on read_epic and log_epic…` (`readCrossEpic`) |
| make `recordFile` (behind `cardPath`/`epicPath`/`crossEpicPath`) join without the throw | `writeCard, writeEpic and writeCrossEpic throw on a traversing name and write nothing outside the board` (`tests/store.test.mjs`) |
| loosen `RECORD_NAME_RE` (admit `/`, `\`, a space) or drop the `.`/`..` exclusion | `isRecordName: one plain filename segment, nothing else` (`tests/store.test.mjs`) |
| replace `mergeCrossEpics`' `store.isRecordName(p)` member test with a non-empty-string check | `a peer cross epic with a traversing member stores only record-name members` (`tests/sync.test.mjs`) |
| `ingestPlanFile`: drop the lexical root check | `ingest: a MISSING path outside both roots -> PLAN_SOURCE_DENIED, not PLAN_UNKNOWN` |
| `ingestPlanFile`: drop the realpath containment | `ingest: a plans-dir symlink to a file outside both roots -> PLAN_SOURCE_DENIED` |
| `ingestPlanFile`: judge `.md` on the given path rather than the realpath | `ingest: a plans-dir .md symlink to a non-.md file under PROJECTS_ROOT -> PLAN_SOURCE_DENIED` |
| `ingestPlanFile`: drop the `.md` check, or compare it case-sensitively | `ingest: a non-.md file under PROJECTS_ROOT -> PLAN_SOURCE_DENIED` / `ingest: a plans-dir source of exactly 1 MiB, named .MD, is ingested` |
| `ingestPlanFile`: drop the size cap, or use `>=` | `ingest: a plans-dir source of 1 MiB + 1 byte -> PLAN_SOURCE_DENIED` / `ingest: a plans-dir source of exactly 1 MiB, named .MD, is ingested` |
| `ingestPlanFile`: copy from `source` rather than `real` | `ingest copies from the realpath the allowlist checked` (spies `fs.copyFileSync`'s source argument: the bytes are the same unless the link is swapped mid-call) |
| `ingestPlanFile`: drop `isFile` | `ingest: a FIFO in the plans dir -> PLAN_UNKNOWN (not a regular file), without blocking` — the test's writer process completes the FIFO open, so the mutant reports success rather than hanging |
| `ingestRoots`: drop or swap a root (the plans dir, or `PROJECTS_ROOT`) | `the conductor attaches a host plan by absolute path over MCP` (`tests/mcp.test.mjs`; the plans dir is outside `PROJECTS_ROOT`) / `update_card plan: an absolute path inside a WORKTREE is copied in` (`PROJECTS_ROOT`) |
| `safePlanFile`: drop the `.md` check, or judge it on `resolved.path` instead of the realpath | set path: `a repo: pointer to a non-.md file -> PLAN_UNKNOWN at update_card, file_card and create_epic`; realpath: `a repo: link to a .md symlink naming a non-.md file is refused on set and missing on read` |
| `planFields`' read at each of its 2 call sites (`readCard`, `readEpic`): skip `safePlanFile` | `a stored repo: link to a .env reads as plan_missing with no body` (`readCard`) / `read_epic: a stored board: link to a non-.md file reads as plan_missing` (`readEpic`) |
| `Number` instead of BigInt in `mergeProject`'s allocator (`maxNum` seed, `trailingIdNumber`, `++maxNum`) | `reassigning an id above 2^53 terminates and takes the exact next integer` (`tests/sync.test.mjs`, a 5 s worker deadline via `tests/_syncAllocWorker.mjs`) |
| `Number` instead of BigInt in `store.nextId` (the scan, or `max + 1`) | `file_card past a card numbered 2^53 mints a new id and leaves that card intact` (`tests/board.test.mjs`) |
| `trailingIdNumber` back to `Number.parseInt` | `slashes and id numbers: the named shapes` and the `idNumber` differential (`tests/lineParsers.test.mjs`, whose oracle is `BigInt(match)`) |
| `resolvePlanForSet`'s ingest at each call site: route around the allowlist in `updateCard` / `fileCard` / the epic upsert | `ingest: a .md file outside both roots -> PLAN_SOURCE_DENIED, card unchanged` (and `PATCH with an absolute plan outside both ingest roots…`, `tests/routes.test.mjs`) / `file_card with a plan outside both roots -> PLAN_SOURCE_DENIED: no card, no id burned` / `create_epic with a plan outside both roots -> PLAN_SOURCE_DENIED, no epic written` |

## The UI, the server and the line parsers: gradeable vs harness-only

`npm test` never renders React, and no test needs `frontend/dist` (`tests/server.test.mjs` serves a
fixture build; `tests/dist.test.mjs` skips when unbuilt), so a copy without the build is green.
Node's type stripping imports the `.ts` modules directly; no extra `preserve` entry is needed.

**Gradeable — a mutant here must die:**

| Site | Suite |
|---|---|
| every branch of `frontend/src/lib/{board,forms,api,persist,acceptanceEdit}.ts` (e.g. drop `api`'s root-relative throw; return instead of throw on non-2xx; send `project` for `scope:'all'`; drop one `syncSummaryText` clause; let one member through `epicCreateRequest`; flip `laneCards`' plan filter; recompute `completed`; send `acceptance` untouched) | `frontendLogic`, `persist`, `acceptanceEdit` |
| `server.js`: drop or move the CSP middleware after the router; edit the `CSP` constant itself (drop `style-src 'unsafe-inline'`, widen a source); judge the `.map` guard on the raw path or case-sensitively; send `err.message` for a 500; drop `nosniff`; serve `index.html` as a fallback; drop the `.map` guard; drop the 503 branch, its log line, or its `/api` pass-through; HTML 404; bind `0.0.0.0` by default | `server` |
| a source-scan subject: `dangerouslySetInnerHTML`/`innerHTML`, `location.href = …` / `location.assign(…)`, `document.cookie`, `parent.postMessage`, `setAttributeNS`, `insertAdjacentElement`, a `style={…}` / `{ style: … }` / `{ 'style': … }` / `createElement('STYLE')` / `el.style.x = …`, an expression `href`, a `'/api…'` literal, a second `fetch`/`localStorage` site, a `{...props}` spread in a feature component | `frontendSafety` |
| reorder or `defer` the bridge tag; a literal colour or `bg-red-500` in feature code; a `classList.toggle('dark')`; drop `type="submit"` from a default `Button`; a fallback token missing | `frontendTheme` |
| deaden any scanner (an empty glob, a regex that never matches, a dropped regex alternative); drop a script type from `UI_CODE_EXTS` or from a guard's file list | the scanner's liveness floor, its known-bad-samples test (one sample per alternative), and the guard's fixture-tree test |
| deaden a repo-wide format gate: remove or invert `doubledLines`' or `crowdedHeadings`' check, drop its fence handling, or drop `ts\|tsx` from `docCitations`' `CITATION_RE` | `the blank-line rule flags a doubled blank line, and only that` (`codeFormat`), `the heading rule flags a crowded heading, and only that` (`docFormat`), `.ts and .tsx citations are extracted, and real ones reach the existence check` (`docCitations`) |
| revert a line-parser helper (`src/cardfile.js`, `src/board.js`) to its regex | `parserTiming` (the 2 s worker deadline) |
| off-by-one / wrong terminator set inside a helper | `lineParsers` (differential against the original regex) |
| `parseEpicFile` reimplements the logbook rule instead of importing `parseLogbookLine` | `parserTiming`'s `store.readEpic` case |

**Ungradeable — mark ungraded; the Playwright harness (`harness/playwright/`) covers them:**
anything in `frontend/src/**/*.tsx` and `frontend/src/hooks/`, CSS/Tailwind classes, Radix wiring,
focus behaviour, layout breakpoints, and the theme following live.

## Ungradeable mutant shapes (pick a different mutation)

- **Reverting a LIVE HTTP route path** (e.g. `/board/:project/cards` back to `/tasks` in
  `src/routes.js`). Ungradeable here, and it looks like a build break rather than a survivor: the
  positive-path route tests call a `json()` helper that does `res.json()` on every response, so an
  unrouted path returns the server's plain-text `Not found` 404 and the helper throws a JSON
  `SyntaxError`. The adapter's compile-error heuristic reads that as a broken
  build, not as a killed mutant. Mutate by **adding an alias route** for the old path instead — it
  grades cleanly, and it is the realistic regression anyway (a back-compat alias quietly re-added,
  which is exactly what `tests/routes.test.mjs`'s 404 guard exists to catch).

## `--jobs` and parallel copy runs

`--jobs N` in `copy` mode is safe for this project. Verified 2026-08-10 as part of
code-mutant cards 2026-0010 / 2026-0029.

**What was wrong.** A `--jobs 4` `/code-mutant:prove` run against this project returned two
verdicts a serial re-run contradicted: `norm-zero-medium-str` as `SURVIVED` (11/0/0, re-ran alone as
`KILLED`), and `filecard-null-refused` as `IMPRECISE` with spurious failures including a
`seedRawCard` test that never calls `fileCard`. A full `--jobs 1` run was clean: 12 mutants, 12
`KILLED`, exit 0.

The cause was entirely in code-mutant's runner, not in this harness or this suite. Its worker pool
keyed each mutant's copy on the ITEM index rather than the WORKER ordinal, so with `jobs=N` and more
than N mutants, two mutants could occupy one copy at once. One mutant's restore then landed while
the other was still measuring — wiping its mutation, so the suite went green and read `SURVIVED` —
and the second restore wrote the first mutant's bytes back as permanent residue, so a later mutant
measured against a foreign edit and failed tests that cannot reach its site. Note the direction that
was *not* observed: the same race produces a false `KILLED` just as easily, and that would have been
silent.

**What changed in code-mutant.** The workspace is now keyed on the worker ordinal, so each worker
owns one copy exclusively. On top of that, three checks make a concurrency-affected verdict
impossible to report as a verdict at all — each yields `ERROR`, never `SURVIVED` and never a
downgraded verdict, because a run whose isolation is in doubt says nothing about coverage in either
direction:

| reason | meaning |
| --- | --- |
| `workspace-occupied` | two mutants tried to occupy one copy |
| `workspace-residue` | the copy holds mutation bytes from outside the current mutant |
| `mutation-not-intact` | the mutated bytes did not survive the measured run |

Copy-mode's no-trace assertion also stopped being a constant pass: a copy left holding mutation
bytes now fails the run with **exit 3** (`RESTORE_FAILED`), which outranks both survivors (1) and
no-verdict (5).

**Why `--jobs N` is safe here specifically.** `jobs=N` runs `node tests/run.mjs` N times
concurrently, in N copies. That is unsafe for a suite that binds a fixed TCP port, writes a fixed
temp or data directory, shares a database or an on-disk fixture it mutates in place, writes a shared
build/package cache, or depends on the checkout's absolute path. None applies:
- Every file that binds a port (`routes`, `server`, `dist`) listens on port `0`, so the OS assigns
  an ephemeral port per copy.
- Every file that writes disk opens its own `fs.mkdtemp(os.tmpdir())` root (`tests/_helpers.mjs`'s
  `freshRoot`, or a local `mkdtemp` for `server.test.mjs`'s fixture build).
  `parserTiming.test.mjs` and `sync.test.mjs` also start worker threads, which share only that
  per-test root.
- The source scanners (`frontendTheme`, `frontendSafety`, `docCitations`, `pluginManifest`) and the
  pure-function files only read. `dist.test.mjs` only reads `frontend/dist`, and skips when it is
  absent.
- The only `preserve` entry is `node_modules`, which the suite only reads. That last point is the
  one to re-check if `preserve` ever grows: **`preserve` entries are symlinked into every copy**, so
  a preserved path is shared writable state across all workers *and* this checkout.

Re-verify before trusting a parallel verdict: a `--jobs N` run whose findings a `--jobs 1` re-run
contradicts is a code-mutant bug, not a coverage finding, and should be reported upward.
