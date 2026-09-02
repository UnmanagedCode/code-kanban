# Protocol — interface contracts

## MCP wire contract

The conductor spawns this plugin as an out-of-process HTTP server and forwards each tool call
to `POST /api/mcp`:

- **Request body:** `{ tool, arguments, caller:{ sessionId, project } }`.
- **Response:** HTTP **200 for every well-formed call**, body `{ result: <any> }` on success or
  `{ error: "<msg>" }` on an envelope failure. Non-200 is a transport-level failure.
- **Raw-text channel (additive):** a success body may instead be `{ meta, text }` — the
  host emits `meta` as one compact-JSON block plus each entry of `text` (always an **array**, in
  order) as a **raw, unescaped** content block after it (code-conductor
  `src/plugins/mcpBridge.ts` → `src/mcp/content.ts` `textPayload`). An empty `text` array emits the
  metadata block alone. A body on this path has **no `result` key**.

  **The split rule** (one rule, decided in `src/mcp.js`): a field gets its own raw text block when
  the reader consumes it **top-to-bottom** — authored prose or a markdown document, **or a listing
  that is the tool's whole payload** (a lane-grouped card list, an epic roster). Everything a
  caller **branches on** stays in the single compact-JSON metadata block: scalars, ids, flags, and
  the **counts** describing the listing as a whole — including the count of what the listing did
  *not* show. When a listing moves to text, every fact a conductor acts on must be *in* the text;
  the JSON block carries only the census.

  One exception: `read_epic`'s `cards` stays JSON. It is a secondary field of a card-detail read
  rather than the payload the caller asked for, and `list_cards({epic})` is the text rendering of
  that same set.

  | tool | JSON metadata block | raw text block(s), in order |
  |---|---|---|
  | `read_card` | `{ok, card:{…frontmatter scalars…}, plan_path[, plan_body, plan_truncated, plan_missing]}` | 1. the card body 2. `plan_body` (only with `includePlan` **and** a non-empty readable file) |
  | `read_card_log` | `{ok, total, count}` | the logbook entries as a `- `-prefixed list |
  | `read_epic` | `{ok, epic:{slug,title,plan,rollup[,projects]}, logbook_total, plan_path[, plan_body, plan_truncated, plan_missing], cards:[summary]}` | 1. `epic.goal` 2. the logbook as a `- ` list 3. `plan_body` (each block omitted when empty) |
  | `list_cards` | `{ok, counts:{…lanes read…}, shown, done_hidden}` | the lane-grouped listing (§ below) |
  | `list_epics` | `{ok, count}` | the epic roster (§ below) |
  | every mutator | unchanged `{result}` | — |

  `meta.card` stays **nested and complete** — every frontmatter scalar including `title` and
  `updated` — minus the three body sections that moved into the text block.
  The channel is **MCP-only**: the GUI's HTTP routes bypass `src/mcp.js` and keep reading these as
  plain JSON fields.
- Missing/empty `tool` → **400** `{error}`; unknown tool name → 200 `{error}`.
- `caller.sessionId` may be `null` when the host can't resolve the caller.

## Result payloads (the `{ok}` domain convention)

Tool handlers **return** a domain result as the `{result}` payload and **never throw** for a
domain outcome:

- Success: `{ ok: true, ... }` (e.g. `{ ok: true, id }`).
- Refusal: `{ ok: false, code, reason }`.

So a refusal travels as `{ result: { ok:false, code, reason } }` at HTTP 200 — a normal MCP
result the conductor relays to the model, **not** an `{error}`. `{error}` is reserved for a
malformed envelope or an unexpected exception.

**Refusal codes:** `PROJECT_UNKNOWN`, `CARD_UNKNOWN`, `EPIC_UNKNOWN`, `EPIC_CONFLICT`, `INVALID_STATE`,
`PLAN_UNKNOWN`.

## Tool signatures

- `file_card({project, title, goal?, acceptance?, epic?, depends_on?, category?, priority?, plan?}) → {ok, id[, plan]}` — card lands in `triage` by default; `category: 'todo'|'backlog'` lands it directly in that lane instead (mirrors triage's legal exits). An illegal `category` value → `INVALID_STATE`. `epic` is omitted or `null` (filed unlinked), else a non-empty string that must already exist → `EPIC_UNKNOWN`; any other shape → `INVALID_STATE` through the same `checkEpic` `update_card` uses (see its `epic` bullet). `priority` is one of `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` (advertised in the manifest as an `enum` with **no `default`**); omitted or `null` → unset; anything else → `INVALID_STATE`. `acceptance` and `depends_on` are each `string[]` — omitted or `null` for none; **anything else, including a non-array or a non-string item, is `INVALID_STATE`** naming the field (and the item's index), never silently coerced to an empty list. Each `acceptance` item runs through the **same** text validator as `update_card`'s `add`/`rename`/`replace` (no newline, non-empty after trim, stored trimmed — see the `acceptance` bullet below), reported as `acceptance[i]: …`. `title` must be a non-empty string containing **no newline or carriage return** (checked on the raw value; `title must not contain a newline`) and `goal` a string or `null` — the **same two validators** `update_card` uses, so the refusal strings are identical at both surfaces (see `update_card`'s `title`/`goal` bullet). `plan` takes the same three input forms as `update_card`'s `fields.plan` (below) and is resolved against the card's freshly-minted id, so an **absolute** path is copied to `plans/<id>.md`; the stored link comes back as `plan` in the result. All of these validate **before** the card is written, so a refusal consumes no id — including a `PLAN_UNKNOWN` plan: no card is created and the next `file_card` gets that same id.
- `log_card({project?, id?, entry}) → {ok}` — two paths, chosen by `id`:
  - **`id` omitted (worker path):** target card resolved server-side from `caller.sessionId`
    (the owned `in-progress` card; ties broken by most-recently-modified). `project` is
    optional: if omitted, every project is scanned for the owned card (same tie-break, across
    projects). No owned card / no session → `CARD_UNKNOWN`.
  - **`id` given (conductor path):** targets that exact card directly, bypassing the owner
    check. `project` is then **required** (ids are per-project, not globally unique) — missing
    → `INVALID_STATE`. Card must be `in-progress`; nonexistent or not `in-progress` →
    `CARD_UNKNOWN`. Logged with `conductor` attribution.
- `log_epic({project?, slug, entry}) → {ok}` — conductor-only; appends to that EPIC's logbook.
  **No lane gate** — an epic has no state and no owner, and the two entries most worth having
  (a resequencing decision before any card starts, a retrospective after the last one lands)
  both occur with no in-progress card; so `EPIC_UNKNOWN` is the only refusal on this path (plus
  `INVALID_STATE` for an empty `entry`), and logging to an epic with zero cards succeeds.
  `project` resolves the epic through the same `resolveEpic` as `read_epic`: that project's own
  epic first, falling back to a cross-project epic covering it; omit `project` to address a
  cross-project epic by slug, and a cross epic addressed with a **non-member** `project` →
  `EPIC_UNKNOWN`. Entries are always `conductor`-attributed, even when the caller has a session
  id — an epic has no owner to credit. The epic's `updated`/`node` stamp is bumped, so the edit
  is visible to sync. There is no card|epic union tool: `log_card` and `log_epic` are separate
  because a flat `inputSchema` cannot express the exclusivity (§ "Manifest / schema
  constraints"); see `.wiki/architecture/card-epic-tool-split.md`.
- `list_cards({project, state?, epic?, includeDone?}) → {ok, cards:[summary]}` — HTTP route shape
  (`board.listCards`, unchanged). **Over MCP** the result rides the raw-text channel: a
  lane-grouped plain-text listing plus `{ok, counts, shown, done_hidden}`. `done` is **hidden by
  default** — the default set is every lane except `done` (triage/backlog/todo/in-progress); the
  header states how many `done` cards were hidden and how to see them. `state:'done'` still
  returns exactly that lane; `includeDone: true` (default `false`, no effect when
  `state` is given) returns every lane instead. `state` reaches `board.listCards` **verbatim**, so
  `INVALID_STATE` still comes from the one validator, and `counts` describes exactly the lanes the
  call read: all five (0 for an empty lane) when no `state` was given, exactly one key when it was.
  `shown`/`done_hidden` split `cards.length` into what the text block shows vs. what it collapsed
  into the header's hidden-count clause. The listing groups by lane (`STATES` order, empty lanes
  print nothing) then by the pre-sorted within-lane order — priority, then **newest card number
  first**. Each row carries id, priority, title, created date, plus `epic`/`owner`/`deps`/`plan`
  only when set — `project` and `state` are not repeated per row (the header/group heading already
  carry them).
- `read_card({project, id, logTail?, includePlan?}) → {ok, card, plan_path[, plan_body, plan_truncated, plan_missing]}` —
  the plan fields are **top-level** on the envelope, never inside `card` (which mirrors frontmatter
  1:1). `plan_path` (the resolved absolute path) is returned **always**, `includePlan` or not; it is
  `null` when the card has no link or the stored link is ungrammatical (e.g. synced from a newer
  peer). `includePlan: true` (default `false`) adds `plan_body` — the plan file read up to a fixed
  **64 KiB** cap (`PLAN_MAX_BYTES` in `src/board.js`; not caller-settable) — plus
  `plan_truncated` (file larger than the cap) and `plan_missing` (a link exists but its file is
  absent/unreadable, incl. a symlink pointing out of its base dir). A dead link is **never a
  refusal**: `plan_body: null, plan_missing: true`. No link at all → `plan_body: null,
  plan_missing: false`.

  **Over MCP the result is not one JSON object.** It is **always** a compact-JSON metadata block
  (`{ok, card, plan_path[, plan_body, plan_truncated, plan_missing]}` — `card` minus `goal`/
  `acceptance`/`logbook`) followed by the **card body** as a raw, unescaped markdown
  block (`## Goal` / `## Acceptance` as real `- [ ]` checkboxes / `## Logbook`), then — only when
  `includePlan` read a non-empty file — the plan verbatim as a **second** raw block. The card body is
  re-rendered from the card object via `cardfile.serializeBody`, so `logTail` and hidden-field
  stripping apply to it exactly as to the metadata.

  `plan_body` is promoted **out of** `meta` only when it is a string, and a block is emitted only
  when that string is non-empty. So with `includePlan: true` there are three outcomes:
  a body was read → no `plan_body` in `meta`, second block present; the file exists but is
  **empty** → no `plan_body` in `meta`, **no** second block, `plan_missing: false`; no link or an
  unreadable file → `plan_body: null` **stays in `meta`** (null is not a string) alongside
  `plan_missing`.

  The empty-file case and "`includePlan` not passed" are told apart by the **presence of
  `plan_missing`/`plan_truncated`** — set (to `false`) only when `includePlan` was passed, absent
  otherwise. Not by `plan_path`, which is returned always and reflects the card's *link*, not the
  flag (`src/board.js` assigns it outside the `includePlan` branch), so it is non-null for both
  calls on a linked card. Over the GUI's HTTP route it stays a single
  JSON object with `goal`/`acceptance`/`logbook`/`plan_body` as fields (`src/routes.js` delegates
  to `board.js`, which is unchanged; only `src/mcp.js` splits).
- `read_card_log({project, id, limit?}) → {ok, entries:[…], total}` — a **card's** logbook,
  most-recent first. `project`/`id` are both required (`required:["project","id"]` in the
  manifest, so `read_card_log({})` is refused by the host's schema layer before dispatch). An
  epic's logbook is read by `read_epic`, which returns it **chronologically** and caps it with
  `logTail` rather than `limit` — the ordering difference is accepted, not a bug; see
  `.wiki/architecture/card-epic-tool-split.md`.
  **Over MCP:** metadata block `{ok, total, count}` (`count` = entries returned after `limit`;
  `total` = the card's full logbook length) plus the entries as one raw `- `-prefixed markdown
  block. Zero entries → metadata block only.
- `move_card({project, id, to, owner?, commit?}) → {ok, from, to}`. Legal transitions:
  `triage→backlog`, `triage→todo`, `backlog→todo`, `todo→in-progress`, `in-progress→done`,
  and corrective `todo→backlog`, `in-progress→todo`, `done→in-progress`. Anything else
  (unknown state, same-state no-op, other pair) → `INVALID_STATE`. `owner` is stored only while
  in `in-progress` and cleared on leaving it. On landing (`→done`), `commit` is stamped if given,
  else auto-captured as the owning worker's live worktree HEAD sha (resolved via the conductor's
  `/api/instances`, using the prior `in-progress` owner's session id) — never the base project
  checkout's HEAD, which won't contain a worktree'd worker's commits until a merge. Failing to
  resolve either way is not an error — the move still succeeds and `commit` is simply left unset.
  A re-land (`done→in-progress→done`) re-runs this resolution: a fresh sha overwrites the prior
  one, but an unresolvable re-land leaves the previously-stamped `commit` untouched.
- `update_card({project, id, fields}) → {ok[, plan]}` (`plan` — the stored link, or `null` — is returned when `fields.plan` was part of the call) — `fields` ⊆ `{title, goal, epic, priority, depends_on, plan, owner, acceptance}`; other keys ignored. Every field validates **before** any mutation, so a refusal leaves the card untouched.
  - **`title`** / **`goal`** — the only two `fields` keys the generic loop assigns **verbatim**, and
    the two shape checks that run **first**, ahead of the `epic`/`priority` checks and ahead of
    `plan` resolution — so a call mixing a bad `title`/`goal` with an **absolute** `plan` path
    ingests no plan file. `title` must be a **non-empty string**: a non-string, `null`, `''` or
    whitespace-only → `INVALID_STATE` (there is no way to clear a title — a card always has one).
    It must also contain **no newline or carriage return** → `INVALID_STATE`, checked on the **raw**
    value (so a leading or trailing newline is refused too, exactly like a criterion's text): the
    title is one frontmatter line, so a newline would not truncate it but inject sibling keys.
    `goal` must be a **string or `null`**, where `null`/`''` clear it to an empty Goal section;
    anything else → `INVALID_STATE`. Both run through the **same** validators `file_card` uses
    (`checkTitle`/`checkGoal` in `src/board.js`), so the refusal strings are byte-identical at the
    two surfaces: `title is required and must be a non-empty string`, `title must not contain a
    newline`, `goal must be a string, or null`.
  - **`epic`** — a **non-empty string** naming an epic already visible to this project (its own
    epic, or a cross-project epic covering it) → else `EPIC_UNKNOWN`; **or `null` to clear the
    card's epic** (like `plan`/`priority`). Everything else → `INVALID_STATE`,
    `epic must be a non-empty string, or null to clear it`: a non-string (`42`, `{}`, `['ep']`),
    `''` or whitespace-only, and every **falsy-but-present** value (`0`, `false`, `NaN`,
    `undefined`). Only an explicit `null` clears, so a dropped or wrong-typed value cannot silently
    orphan a card from its epic. The shape check runs **first**, through the **same** validator
    `file_card` uses (`checkEpic` in `src/board.js`), so the refusal string is byte-identical at the
    two surfaces; existence stays the separate `EPIC_UNKNOWN` check. Slug *syntax* is not
    re-validated here — `SLUG_RE` is `create_epic`'s gate, and a well-formed name that matches no
    record is `EPIC_UNKNOWN`.
  - **`priority`** — one of `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, matched **exactly** (case-sensitive),
    **or `null` to clear the card back to unset** (like `plan`). Everything else — `''`, a lowercase
    spelling, a legacy integer, `undefined`, any unknown word → `INVALID_STATE`. Only an explicit
    `null` clears, so a dropped or misspelled value cannot silently erase a judgement. Tolerant
    coercion exists **only** on the disk-parse path, never here — see
    `.wiki/gotchas/priority-legacy-tolerance.md`.
  - **`plan`** — a **link to a plan file**, never the plan text. Grammar (defined here, once).
    **Input forms (3)** — `board:<rel>` / `repo:<rel>` (a typed **pointer**, validated by stat,
    **never copied**): `board:` resolves under `<kanbanRoot>/projects/<project>/plans/` — or under
    the **board-level** `<kanbanRoot>/plans/` when there is **no owning project**, which happens
    for exactly one owner, a cross-project epic (`planBaseDir(null, 'board')`; `repo:` has no base
    without one and is refused `INVALID_STATE`) — `repo:`
    under `<PROJECTS_ROOT>/<project>/` — the **base checkout**, never a worktree, so a `repo:` link
    only resolves once the plan is merged; a bare `<rel>` (means `board:`, normalised on store);
    and an **absolute path** (**ingested**: copied to
    `<kanbanRoot>/projects/<project>/plans/<id>.md`, `plans/` created if absent, an existing copy
    overwritten — last write wins, no versioning; the source is never moved or modified).
    **Stored form (1)** — always `board:<rel>` or `repo:<rel>`. Unchanged by this feature, so
    reads, sync, `delete_card`'s unlink and the GUI all see one grammar.
    An absolute path pointing at an in-tree file yields a board **snapshot**, not a live `repo:`
    pointer — pass `repo:<rel>` explicitly for that. Both `update_card` and `file_card` return the
    resolved `plan` link when the field was part of the call.
    Refused `INVALID_STATE`: an empty value, a non-string, an embedded newline (frontmatter is one
    verbatim line), any other scheme (`file:`, `http:`, `C:\…`), an absolute path **after an
    explicit scheme** (`board:/abs` — the scheme makes it a pointer, and a pointer must be
    relative), and `../` escaping a base. Refused `PLAN_UNKNOWN` when a **pointer** is grammatical
    but resolves to no regular file inside its base (incl. via a symlink out of it), **and** when
    an absolute source is missing, a directory, not a regular file, or cannot be read/copied — the
    card's `plan` is left unchanged. `plan: null` clears it.
  - **`owner`** — only settable on an **`in-progress`** card → else `INVALID_STATE` (a plan-worker →
    implementer handoff needs no lane move). Must be a non-empty single token with no whitespace;
    `null` clears it. A real change stamps a logbook line `owner <from> -> <to>` (`none` for an
    absent side); a no-op set logs nothing.
  - **`acceptance`** — accepts exactly **one** of three shapes:
    `{ops:[…]}`, `{replace:[…]}`, or `null` (clears the list). Both `ops` and `replace` present, or
    neither, → `INVALID_STATE`; any other shape (incl. a bare array — the natural `string[]` guess,
    since that is `file_card`'s form) → `INVALID_STATE` naming all three accepted shapes.
    `file_card`'s `acceptance: string[]` **filing-time** input form is a different **container**
    shape (a flat list, no ops) and is refused here. The **per-criterion text rules are the same at
    both surfaces**: no newline, non-empty after trim, stored trimmed.

    **`{ops:[…]}`** — each op is one of `{op:'add', text}`, `{op:'remove', index}`,
    `{op:'rename', index, text}`, `{op:'done', index, done}`; every op is **total** (no optional
    payload fields — `done` always carries an explicit boolean so unticking is reachable). `index`
    is the **0-based position in the card's acceptance list as `read_card` returns it**. Every op
    resolves against that single **pre-edit snapshot in one pass**: index `i` always means the
    `i`-th pre-edit item, so two `remove`s in one call never shift each other. Survivors keep their
    pre-edit relative order; `add`s are **appended after all survivors**, in the order the `add` ops
    appear in `ops`. Conflicting ops on the same index are **last-write-wins within the pass**
    (two `rename`s on index 0 → the later text), except that a `remove` on index `i` is **terminal**
    — the item is absent from the result regardless of op order, and a later `rename`/`done` on that
    same index is then a silent no-op, not a refusal. An unknown `op`, a non-integer or out-of-range
    `index`, a non-boolean `done`, or (for `add`/`rename`) a non-string/newline-bearing/
    empty-after-trim `text` → `INVALID_STATE` naming the offending op's index and name.

    **`{replace:[…]}`** — sets the list from strings (the shape the GUI's edit-form textarea sends),
    preserving each item's `done` flag when the new **trimmed** text exactly matches a **pre-edit**
    item's stored text — first pre-edit occurrence wins on a duplicate pre-edit text; a duplicate new
    text is a lookup, not a consumption, so every occurrence inherits the same flag. Unmatched items
    start unchecked. Same text refusals as `add`/`rename` above, reported as
    `acceptance.replace[i]: …`.

    Stored criterion text is always the **trimmed** value: a criterion is one `- [ ] <text>` line on
    disk and the parser trims before matching, so an untrimmed newline or empty-after-trim text would
    silently lose data on the next read — refused here instead (see
    `.wiki/gotchas/acceptance-line-round-trip.md`). No logbook line is written for an acceptance edit
    (unlike `owner`, this is an edit, not a handoff). The edited list is **not** echoed back in the
    result — `read_card` is the read path.
- `create_epic({project?, projects?, slug, title, goal?, plan?}) → {ok[, plan]}` — `slug` matches `^[a-z0-9._-]+$`; idempotent upsert. `title` is required and always overwrites; **every optional field the caller OMITS is preserved** (`goal`, `plan`, and the logbook, which no caller can pass) — pass `goal: ''`/`null` or `plan: null` to clear one explicitly. Presence is tested `!== undefined`, **never** `'goal' in args`: `src/routes.js` destructures the request body, so the key is always present holding `undefined`, and an `in` test would make every GUI epic re-post clobber the goal. `created` is preserved; for a cross-project epic the member `projects` list **is** replaced — membership is mutable. `plan` is a link to the epic's PLAN file (the *strategy*: why these choices, why this sequence — not the dependency graph, which `depends_on` owns, and not progress, which the rollup owns), taking the same three input forms as `update_card`'s `fields.plan`; an **absolute** path is ingested to `plans/epic-<slug>.md` and stored as `board:epic-<slug>.md`. The `epic-` prefix is load-bearing: `SLUG_RE` admits a card-id-shaped slug (`2026-0001`), so an unprefixed name would overwrite that card's own plan file. For a **project-scoped** epic `board:` resolves under that project's `plans/` dir; a **cross-project** epic has no owning project, so its `board:` resolves under the **board-level** `<kanbanRoot>/plans/` dir and `repo:` is refused `INVALID_STATE`. The stored link is returned as `plan` only when `plan` was part of the call. A malformed value is refused `INVALID_STATE` **before any lock**, an unresolvable one `PLAN_UNKNOWN` — either way nothing is written. Give **exactly one** of `project` (project-scoped) or `projects` (a cross-project epic spanning ≥2 members) → else `INVALID_STATE`. A slug may not be both a cross-project epic and a per-project epic in one of its members → `EPIC_CONFLICT` (guarded in both create orders).
- `list_epics({project}) → {ok, epics:[{slug, title, rollup, projects}]}` — the project's own epics (`projects:null`) plus cross-project epics spanning it (`projects:[…]`, `rollup` aggregated over all members). **Over MCP:** the result rides the raw-text channel — one epic-roster text block (slug, title, per-state rollup always printed for all five lanes, `cross: <members>` for a cross-project epic) plus `{ok, count}`. Unlike `list_cards`, there is no default-hide: an epic has no state, and its rollup's `done` count is the fact a reader wants, not noise. There is no honest whole-list aggregate for the rollups (a cross-project epic's rollup already spans other projects), so `meta` carries only the epic count — every rollup number lives in the text.
- `read_epic({project?, slug, logTail?, includePlan?}) → {ok, epic:{slug,title,goal,plan,rollup[,projects],logbook}, logbook_total, plan_path[, plan_body, plan_truncated, plan_missing], cards:[summary]}` — `project` may be the epic's **owning** project (a project-scoped epic resolves first) **or any member** of a cross-project epic; omit it to address a cross-project epic by slug. A cross epic addressed with a **non-member** `project` → `EPIC_UNKNOWN`. One resolver (`resolveEpic` in `src/board.js`) serves this and `log_epic`, so the two cannot disagree. A cross epic's `rollup` and `cards` aggregate across all member projects and `epic.projects` lists them. `epic.plan` is the raw stored link (mirroring the record, as `card` mirrors frontmatter) and `epic.logbook` is returned **by default** in **chronological** order, `logTail` keeping only the last N entries (`logTail: 0` → zero, the same `slice(-0)` trap `read_card` avoids). `logbook_total` is **top-level** and is the logbook's **full** length **before** any `logTail` cap, so a tail'd caller can tell 5 entries from 50. The plan fields are **top-level** and behave exactly as `read_card`'s — `plan_path` always, `includePlan` adding `plan_body`/`plan_truncated`/`plan_missing` under the same 64 KiB `PLAN_MAX_BYTES` cap, a dead link degrading to `plan_missing: true` rather than refusing. Both reads run through one shared implementation (`planFields` in `src/board.js`). The hidden `updated`/`node` stamp is stripped (the response is a field whitelist). **Over MCP:** metadata block `{ok, epic:{slug,title,plan,rollup[,projects]}, logbook_total, plan_path[,…], cards:[summary]}` (`logbook_total` is a scalar, so it stays in the metadata block by the split rule) plus up to three raw blocks in order — `epic.goal`, the logbook as a `- ` list, then `plan_body` — each omitted when empty; `cards` stays JSON — the split rule's one exception, since it is a secondary field of a card-detail read rather than the payload the caller asked for (`list_cards({epic})` is the text rendering of that same set).
- `delete_card({project, id}) → {ok}` — permanently removes the card's file; unknown id → `CARD_UNKNOWN`. Also best-effort removes the card's plan file **when the link is `board:`** — a `repo:` plan is a source-tree file and is never touched; a failed unlink leaves an orphan, never a refusal. Irreversible and not sync-aware: see "Cross-instance sync" in `docs/architecture.md`.

A `summary` is `{id, title, state, project, epic, priority, owner, depends_on, created, plan}`
(`plan` is the link, or `null`; `priority` is one of the four levels, or `null` when the card is
unset — i.e. nobody has judged it). Card
lists (`list_cards`, `read_epic`) are ordered **column (`STATES` order) → priority
(`CRITICAL`→`HIGH`→`MEDIUM`→`LOW`→unset) → card number descending (newest first)**; unset ranks
after every judged level, so an unjudged card never outranks a judged one. The id tiebreak is
**numeric** on the `YYYY-NNNN` shape — year, then number — not lexicographic, because the number is
not a fixed width (`2026-10000` is a valid id and sorts ahead of `2026-9999`). An id **not** matching
that shape (only reachable from a peer that minted it) sorts after every id that does, and such ids
are ordered among themselves by reverse string compare. `list_cards`' MCP text rendering of a `summary` prints
`id`, `priority`, `title` and the date-only `created`; `epic`/`owner`/`depends_on`/`plan` print only
when set (never as a bare `epic —`); `project` and `state` are never repeated per row — the
listing's header and per-lane group heading already carry them. A `rollup`
is a per-state count object over `triage/backlog/todo/in-progress/done`. `file_card`/`update_card`
accept an `epic` slug that resolves to a per-project epic in the card's project **or** a
cross-project epic covering it → else `EPIC_UNKNOWN`. The full card object (from `read_card`)
additionally carries an optional `commit` field, set once the card lands; `commit` is not in
`update_card`'s `UPDATABLE` set — it's stamped only by `move_card`. `plan`, by contrast, **is** in
`UPDATABLE` — it is the one card field a caller sets directly. The caller-set fields with their own
set-time validator are listed as `PRE_RESOLVED` in `src/board.js` (`resolvePlanForSet`,
`resolveAcceptanceForSet`, `resolveDependsOnForSet`); the rest of `UPDATABLE` lands verbatim.

## Manifest / schema constraints

`conductor.plugin.json` tool `inputSchema`s must be a **flat object schema** (host-enforced):
no `$ref/oneOf/anyOf/allOf/not`, no nested `properties`. Consequence: `update_card.fields` is
advertised as an opaque `{type:"object"}` and validated at runtime — `fields.acceptance`'s nested
op object (`{ops:[…]}` / `{replace:[…]}`) is simply one level deeper inside that same opaque value,
runtime-validated for the same reason. Array params (`acceptance`, `depends_on`) use
`{type:"array", items:{type:"string"}}` — this is `file_card`'s flat top-level `acceptance: string[]`
param, unrelated to `update_card.fields.acceptance`'s nested shape. The advertised
`{type:"array", items:{type:"string"}}` is **advisory**: the host does not enforce it, and calls have
reached `board.fileCard` with a non-array `acceptance`. The runtime checks in `src/board.js` are what
refuse them.

The same constraint is why there is no single card|epic logging or logbook-reading tool: a
`oneOf` over the two addressing shapes is rejected outright, so the exclusivity lives in two
tools with disjoint `required[]` (`log_card` / `log_epic`, and `read_card_log` / `read_epic`)
rather than in prose. See `.wiki/architecture/card-epic-tool-split.md`.

## Web GUI HTTP routes

The in-process web GUI (`frontend/`, served at `/` by `express.static`) talks to the same
`board.js` service layer over `GET`/`POST`/`PATCH` routes under `/api`. They are a **thin 1:1
delegate**: each route calls the matching `board.js` function and passes its `{ok}` envelope
through unchanged as the HTTP body.

**Envelope rule (same as the MCP bridge):** a domain refusal `{ok:false, code, reason}` is a
**normal result returned as HTTP 200** — not a transport failure. Only malformed JSON
(`entity.parse.failed`) → **400** `{error:"invalid request body"}`, and an unexpected throw →
**500** `{error}`. So `GET /api/board/ghost/cards` returns 200 `{ok:false, code:"PROJECT_UNKNOWN",
…}`, and an illegal move returns 200 `{ok:false, code:"INVALID_STATE", …}`.

| Method + path | Delegate | Body / query | Returns |
|---|---|---|---|
| `GET /api/projects` | `projects.listProjects` | — | `{projects:[name]}` (502 `{error}` if the catalog fetch throws) |
| `GET /api/board/meta` | `STATES` + `ALLOWED_TRANSITIONS` + `PRIORITIES` | — | `{states:[…], transitions:["from>to",…], priorities:["CRITICAL","HIGH","MEDIUM","LOW"]}` (`priorities` in rank order, highest first — the GUI's priority selects render from it rather than hardcoding a copy) |
| `GET /api/board/:project/cards` | `board.listCards` | `?state`, `?epic` | `{ok, cards:[summary]}` |
| `GET /api/board/:project/cards/:id` | `board.readCard` | `?includePlan=1\|true` | `{ok, card, plan_path[, plan_body, plan_truncated, plan_missing]}` (full: goal, acceptance, logbook). Any other `includePlan` value is falsy. The GUI always sends `includePlan=1` and reads `plan_body` as a field (the raw-text channel is MCP-only). |
| `POST /api/board/:project/cards` | `board.fileCard` | `{title, goal?, acceptance?, epic?, depends_on?, priority?}` | `{ok, id}` (lands in `triage`; `priority` omitted or `null` → unset). The route destructures a fixed field list and deliberately does **not** pass `plan` — the GUI has no file picker and documents the plan link as non-editable. A non-array or non-string-item `acceptance`/`depends_on` is refused `INVALID_STATE`, not emptied (same refusals as the tool). |
| `PATCH /api/board/:project/cards/:id` | `board.updateCard` | body **is** `fields` ⊆ `{title, goal, epic, priority, depends_on, plan, owner, acceptance}` | `{ok[, plan]}` (same refusals as the tool, incl. `PLAN_UNKNOWN`; an absolute `plan` is ingested here too — the copy lives in `board.js`, not at a surface; a bare `acceptance` array — e.g. `[{text,done}]` — is refused `INVALID_STATE`, not silently ignored: it must be `{ops:[…]}`, `{replace:[…]}`, or `null`) |
| `POST /api/board/:project/cards/:id/move` | `board.moveCard` | `{to, owner?, commit?}` | `{ok, from, to}` |
| `GET /api/board/:project/epics` | `board.listEpics` | — | `{ok, epics:[{slug, title, rollup, projects}]}` (incl. cross-project epics spanning the project) |
| `GET /api/board/:project/epics/:slug` | `board.readEpic` | — | `{ok, epic, logbook_total, plan_path, cards:[summary]}` (resolves a cross-project epic the project belongs to). No `?includePlan`: no GUI caller needs the body. |
| `POST /api/board/:project/epics` | `board.createEpic` | `{slug, title, goal?}` | `{ok}` (project-scoped). Like `POST /cards`, the route destructures a fixed field list and deliberately does **not** pass `plan` — the GUI has no file picker. An omitted `goal` is **preserved** (the destructure passes the key holding `undefined`, which is not a set). |
| `GET /api/epics/:slug` | `board.readEpic` | — | `{ok, epic, logbook_total, plan_path, cards:[summary]}` (cross-project epic by slug) |
| `POST /api/epics` | `board.createEpic` | `{slug, title, goal?, projects:[…]}` | `{ok}` (cross-project epic; `projects` has ≥2 members). Same two notes as the project-scoped route: no `plan`, and an omitted `goal` is preserved. |
| `GET /api/sync/export` | `board.exportBoard` | `?scope=project\|all`, `?project` (required for `project`) | `{ok, nodeId, scope, projects:{<project>:[fullCard]}, projectEpics:{<project>:[epic]}, crossEpics:[epic]}` |
| `POST /api/sync/pull` | `board.syncPull` | `{peerUrl, scope, project?}` | `{ok, summary:{added, updated, reassigned[], droppedDeps[], skippedProjects[], skippedCards[], epicsAdded, epicsUpdated, epicConflicts[], skippedEpics[], perProject}}` |

Notes:
- The `POST /epics` route exposes `createEpic`'s **real behavior — an upsert**: an existing slug
  is refreshed (`title` overwritten, every omitted optional field preserved) with `created`
  preserved; it never refuses an existing epic. (The tool name `create_epic` is a slight misnomer;
  it is idempotent upsert.)
- `move` passes `owner: owner || 'gui'`. `board.js` stores `owner` only on entering
  `in-progress` and clears it on leaving, so the `'gui'` attribution affects only the move's
  logbook line (and in-progress ownership) — never a stuck owner on other columns.
- The `meta` route is the GUI's single source for legal move targets; `transitions` is the
  `ALLOWED_TRANSITIONS` Set serialized as `"from>to"` strings.
- **Sync (cross-instance).** `GET /api/sync/export` is the **only** endpoint that exposes a
  card's hidden `uid`/`node`; every other read (`read_card`, `/cards/:id`, summaries) strips
  them. It is read-only from the caller's view but lazily backfills the version stamp on any
  legacy card it serves. No auth: possession of the code-hub-forwarded URL is the capability.
  `POST /api/sync/pull` fetches the peer's export (`<peerUrl>/api/sync/export`) **backend-to-backend**
  (avoids browser CORS) and merges by `uid` (union + card-level last-edit-wins). The pull summary
  contains **display ids/slugs/counts only** — never `uid`/`node` (it reaches the GUI). Malformed peer
  cards (missing/non-string `id`, or an unknown column) are skipped and listed in `skippedCards`.
  **Epics** are exported (`projectEpics`/`crossEpics`) and merged BEFORE cards, matched by **slug**
  (whole-epic last-edit-wins; hidden `updated`/`node` exposed only by export, never by `read_epic`/
  `list_epics`). A slug that is a project epic on one side and cross-project on the other is skipped +
  reported in `epicConflicts` (never merged/deleted — grow-only); malformed epics (bad slug / cross
  epic with <2 members) go to `skippedEpics`. A cross epic's `projects` list is filtered to
  non-empty **strings** first, so junk members are dropped *before* that <2 check — an epic left
  too short by the filter is skipped, not half-written. Beyond skip and conflict there is a **third
  outcome**: a well-formed epic whose BODY fields are malformed (`goal` not a string, `plan` a
  non-string or newline-bearing value, `logbook` not an array of strings) is neither skipped nor
  fatal — it **merges with the bad values dropped, not repaired** (`normalizeRemoteEpic` in
  `src/board.js`), and **nothing in the summary reports the drop**. Dropping matters because these
  reach a hand-rolled serializer: an unguarded value throws inside `withLock(CROSS_LOCK)`, which
  runs *before* the per-project card loop, so one bad epic body would fail the entire pull —
  well-formed cards included. Epics are deliberately stricter than cards here; the card path has
  the same `goal` hole, tracked separately as card `2026-0026`.
  Refusals: malformed `peerUrl` or a blocked host → 200 `{ok:false, INVALID_STATE}`; an
  unreachable/garbage/oversized peer → 200 `{ok:false, SYNC_UNREACHABLE}`.
  **SSRF guard**: `peerUrl` pointing at a loopback / private / link-local IP literal
  (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` incl. `169.254.169.254`, `::1`,
  `fc00::/7`, `fe80::/10`, `localhost`) is refused; the peer fetch does not follow redirects and is
  bounded by a 15 s timeout + 25 MB size cap. Hostnames are not DNS-resolved (lightweight guard —
  a code-hub peer is a public host); set `CODE_KANBAN_SYNC_ALLOW_PRIVATE=1` to permit private
  targets for local dev / the visual harness. See `docs/architecture.md` and
  `.wiki/architecture/cross-instance-sync.md`.
