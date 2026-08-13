# 2026-0020 — Make acceptance criteria editable

> **Plan-mode note.** This session is restricted to writing this one file, so the plan lives here
> rather than at `plans/2026-0020-acceptance-editable.md` in the worktree. **Step 0 for the
> implementer:** copy this file to
> `/workspaces/cc-projects/code-kanban_worktree_33a62f/plans/2026-0020-acceptance-editable.md`
> and commit it with the work.

## Context

Acceptance criteria are **write-once**. `file_task` accepts `acceptance: string[]`
(`src/board.js:242`) and materialises it at `src/board.js:286` as `{text, done:false}` records, but
`updateTask` (`src/board.js:478`) applies only the fixed `UPDATABLE` list
(`src/board.js:476` — title, goal, epic, priority, depends_on, plan, owner), so an `acceptance` key
is silently dropped. `src/routes.js:100-101` documents the omission as intentional, and
`frontend/app.js:339-344` renders the checklist with `disabled` checkboxes; the only acceptance
textarea (`frontend/app.js:435`) belongs to the file-new form.

Net effect: a criterion worded wrong at filing can only be fixed by `delete_task` + re-file, or by
hand-editing the card markdown. This change makes the list editable through `update_task` and
through the GUI's task edit view, without touching `file_task`.

The contract below is **settled with the card owner** — implement it as written; it is not a
starting point for redesign.

## The contract

`update_task`'s `fields.acceptance` accepts exactly three shapes:

```js
{ops: [ {op:'add',    text},
        {op:'remove', index},
        {op:'rename', index, text},
        {op:'done',   index, done: <boolean>} ]}
{replace: string[]}
null                        // clears the list
```

Rules that are decided (do not re-derive):

- `index` is the **0-based position in the card's acceptance list as `read_task` returns it**.
- Ops resolve against the **pre-edit snapshot** in a **single pass**. Two `remove`s in one call must
  not shift each other.
- Every op is **total** — no optional payload fields. `done` carries an explicit boolean so
  unticking is reachable. `rename` carries only `text`.
- `{replace:[...]}` sets the list from strings, **preserving each item's `done` flag where the new
  text exactly matches a pre-edit item**; unmatched items start unchecked. This is the shape the GUI
  textarea round-trips.
- `file_task`'s `acceptance: string[]` input form is **UNCHANGED**. The two forms are deliberately
  not unified.
- Every refusal returns **before** the single `store.writeTask`, so nothing is half-applied —
  matching how `plan`/`owner` validate up-front at `src/board.js:493-517`.
- **No logbook line** for an acceptance edit. `owner` is the only field that logs, because it is a
  handoff, not an edit (owner decision).

### Result ordering (define once, document everywhere)

1. Ops resolve against pre-edit indices in one pass: index `i` always means the `i`-th item of the
   list `read_task` returned, no matter what other ops do.
2. Survivors keep their relative pre-edit order.
3. `add`s **append after all survivors**, in the order the `add` ops appear in `ops`.
4. Conflicting ops on the same index are **last-write-wins within the pass** (two `rename`s on
   index 0 → the later text). A `remove` on index `i` is **terminal**: the item is absent from the
   result regardless of op order, and a `rename`/`done` on that same index is then a no-op. This is
   **not** a refusal — the refusal table is closed.

## Files touched

### 1. `src/board.js` — validator + `updateTask` wiring

**Add a validator sibling to `resolvePlanForSet` (`src/board.js:138`)**, placed next to it in the
same "set-time validator" neighbourhood (~`src/board.js:146`, after `resolvePlanForSet`, before
`readPlanBody`). It is **pure**: it takes the pre-edit list and the caller value and returns the
whole next list or a `fail()`. It writes nothing.

```js
const ACCEPTANCE_OPS = ['add', 'remove', 'rename', 'done'];

// The single set-time validator for update_task's fields.acceptance. Pure:
// (PRE-EDIT list, caller value) -> {list} | a fail(). Nothing here writes —
// updateTask's one store.writeTask stays the only mutation, so every refusal
// below leaves the card untouched. file_task's string[] form is separate and
// deliberately not routed through here.
function resolveAcceptanceForSet(current, value) { … }

// A criterion is ONE `- [ ] <text>` line in the card file
// (taskfile.serializeBody), and taskfile.parse trims the line before matching.
// So text with a newline splits into a line the parser DROPS, and
// empty-after-trim fails the regex's `\s+` and vanishes. Both are silent data
// loss on the next read, so both are refused here and the stored value is the
// TRIMMED text.
function cleanAcceptanceText(text, where) { … }   // -> {text} | {error}
```

Structure of `resolveAcceptanceForSet`:

- `value === null` → `{list: []}`.
- not an object, or an array → refuse (see refusal table for the exact reason — it must name all
  three shapes).
- `('ops' in value) === ('replace' in value)` → refuse (covers both-present and neither-present).
- `replace` path → `replaceAcceptance(current, value.replace)`.
- `ops` path → `applyAcceptanceOps(current, value.ops)`.

`applyAcceptanceOps` is **two passes over the ops array**:

- **Pass 1 validates every op** against the pre-edit snapshot and produces a *normalised* op list.
  It must **not mutate the caller's op objects** — `fields` is caller-owned and `src/routes.js`
  hands it straight from `req.body`. Index check is
  `Number.isInteger(op.index) && op.index >= 0 && op.index < current.length`.
- **Pass 2 builds the result** with a **tombstone**, never an in-place splice — this is what makes
  single-pass resolution true:

```js
const next = current.map((a) => ({ text: a.text, done: a.done })); // copy; never alias the parsed card
const removed = new Set();
const appended = [];
for (const op of checked) {
  if (op.kind === 'add') appended.push(op.text);
  else if (op.kind === 'remove') removed.add(op.index);
  else if (op.kind === 'rename') next[op.index].text = op.text;
  else next[op.index].done = op.done;
}
return { list: [...next.filter((_, i) => !removed.has(i)),
                ...appended.map((text) => ({ text, done: false }))] };
```

`replaceAcceptance` preserves ticks **by text, not by index**:

```js
const doneByText = new Map();
for (const a of current) if (!doneByText.has(a.text)) doneByText.set(a.text, a.done); // first pre-edit occurrence wins
// per entry: cleanAcceptanceText -> refuse or push {text, done: doneByText.get(text) ?? false}
```

The match is on the **trimmed** new text against the **stored** pre-edit text (stored text is
already trimmed-equivalent, since `parse` trims the line). Lookup, **not** consumption: duplicate
new texts all inherit the same flag.

**Wire into `updateTask`:**

- `src/board.js:476` — add `'acceptance'` to `UPDATABLE`, so the constant stays the honest catalog
  of what `update_task` can change and `docs/protocol.md`'s `UPDATABLE` prose stays true.
- New pre-computation block **after** the `owner` block (~`src/board.js:517`), before the generic
  loop:

```js
let acceptanceNext;
if ('acceptance' in fields) {
  const resolved = resolveAcceptanceForSet(task.acceptance, fields.acceptance);
  if (resolved.ok === false) return resolved;
  acceptanceNext = resolved.list;
}
```

- `src/board.js:519` — extend the skip guard to
  `if (!(key in fields) || key === 'plan' || key === 'owner' || key === 'acceptance') continue;`
  (a `PRECOMPUTED` Set was considered and rejected as churn on a hot review path).
- After the loop, alongside `if ('plan' in fields) task.plan = planNext;` (`src/board.js:523`):
  `if ('acceptance' in fields) task.acceptance = acceptanceNext;`
- **Return shape unchanged** — `{ok:true}` (or `{ok:true, plan}`). The edited list is **not** echoed
  back; `read_task` returns it. (Decision: YAGNI, and it keeps `plan` as the only conditional
  response key.)

### 2. `src/mcp.js` / `conductor.plugin.json` — schema + description

`src/mcp.js` needs **no code change**: `update_task` is a straight `board.updateTask` delegate
(`src/mcp.js:16`) and `RAW_TEXT` (`src/mcp.js:45`) doesn't list it. The advertised surface lives in
`conductor.plugin.json`:

- `conductor.plugin.json:122` — extend the `update_task` **tool description**: add `acceptance` to
  the `fields` key list and state the three shapes, the four ops, that `index` is 0-based against
  `read_task`'s list, single-pass pre-edit resolution, `add` appends in order, `replace` keeps ticks
  on exact text match, `null` clears, and that a malformed shape/op is `INVALID_STATE`.
- `conductor.plugin.json:128` — extend the `fields` **property description** the same way, keeping
  the existing "advertised as an opaque object (flat-schema constraint); validated at runtime" note.

**No schema-shape change and no escalation needed.** Per
`.wiki/gotchas/flat-inputschema-constraint.md`, `fields` is already an opaque `{type:"object"}`
with runtime validation — the nested op shape is simply one level deeper inside a value the host
never inspects. `tests/pluginManifest.test.mjs`'s flat-subset assertions keep passing untouched.

### 3. `src/routes.js` — comment only (deliberate behaviour change)

`src/routes.js:102-103` already passes `fields: req.body ?? {}` **wholesale** — it does *not*
destructure a field list, so `acceptance` reaches `updateTask` today and is dropped only by
`UPDATABLE`. **The only code change here is deleting the now-false comment** at
`src/routes.js:100-101` and replacing it with: the body **is** the `fields` object; `acceptance`
takes `{ops}` / `{replace}` / `null`, validated in `board.js`.

**This is a deliberate behaviour change, not a test fix.** A PATCH body carrying a bare
`acceptance: [{text, done}]` array was previously **silently ignored** and now **refuses**
`INVALID_STATE`. That is the intended direction (fail loudly, per `CONVENTIONS.md`), it is why the
malformed-shape reason must name all three accepted shapes, and it is why
`tests/routes.test.mjs:129-140` — which currently *asserts* the silent-ignore behaviour — is
**rewritten**, not extended. Flag it in the commit message.

### 4. `frontend/app.js` — editable acceptance in the edit view

- `renderEditForm` (`frontend/app.js:368`) — insert after the **Goal** field
  (`frontend/app.js:372`), so the edit form mirrors the file-new form's field order:

```js
el('label', { class: 'field' }, ['Acceptance (one per line)',
  el('textarea', { name: 'acceptance', rows: '3' }, (t.acceptance || []).map((a) => a.text).join('\n'))]),
el('p', { class: 'hint' }, 'Ticked criteria keep their tick when the text is unchanged. Empty clears the list.'),
```

  (The 3-arg string-child form is already used for the Goal textarea at `frontend/app.js:372`.)

- `doEdit` (`frontend/app.js:385`) — add to the `fields` object, reusing the **exact split/trim/
  filter chain** from `doFileTask` (`frontend/app.js:458`) so blank lines never reach the server and
  can't trip the empty-text refusal:

```js
acceptance: { replace: fd.get('acceptance')?.toString().split('\n').map((s) => s.trim()).filter(Boolean) },
```

  An empty textarea therefore sends `{replace: []}`, which clears the list.

- **Read view unchanged** (`frontend/app.js:338-344`): the checkboxes stay `disabled`. Per-item
  ticking from the GUI is out of scope — `{op:'done'}` covers it over MCP.

### 5. `frontend/styles.css` — no change (verified)

The new controls reuse existing rules: `.field` (`frontend/styles.css:42`), `.form-grid textarea`
(`:214`), `textarea { resize: vertical }` (`:56`), and `.hint` (`:218`). **Do not invent CSS** — if
the screenshot shows a layout problem, fix it then and say so.

### 6. Docs

- **`docs/protocol.md`**
  - `:114` — add `acceptance` to `fields ⊆ {…}`.
  - New **`acceptance`** sub-bullet under `update_task`, sibling to the existing `priority` / `plan`
    / `owner` sub-bullets (`:115-144`), carrying: the three shapes, the four ops, 0-based `index`
    against `read_task`'s list, single-pass pre-edit resolution (two removes don't shift each
    other), `add` appends in ops order, same-index LWW + `remove` is terminal, `replace` keeps
    ticks on exact trimmed-text match with first-pre-edit-occurrence winning on duplicates, `null`
    clears, stored text is trimmed, and the full `INVALID_STATE` list. State explicitly that
    `file_task`'s `string[]` form is a **different, unchanged** input shape.
  - `:160-161` — the `UPDATABLE`/`commit`/`plan` paragraph: `acceptance` is now the **second**
    caller-set field with its own set-time validator.
  - `:168` — flat-schema note: add that `fields.acceptance`'s nested op object is runtime-validated
    for the same reason.
  - `:190` — PATCH row: the body set gains `acceptance`; note the bare-array refusal.
  - `:79` and `:97` (`read_task` raw-text channel) — **verified no change**: acceptance is still a
    body section and the read path is untouched.
- **`docs/features.md`**
  - `:~99` — the sentence "Acceptance, Logbook, Commit and the plan link are not editable in the
    GUI" is now false: Logbook, Commit and the plan link stay non-editable; **acceptance becomes
    editable**.
  - the edit-form field list on the preceding lines — `(title/goal/epic/priority/depends_on)` gains
    acceptance, described as one-criterion-per-line with ticks preserved on unchanged text and an
    empty box clearing the list.
- **`.wiki/architecture/gui-seam-contract.md:50-56`** — the "Read-only logbook / acceptance"
  section asserts the now-false invariant outright. Retitle to **"Read-only logbook; editable
  acceptance"**: the logbook stays append-only-by-worker (`log_progress` resolves the card from
  `caller.sessionId`, which the GUI can't supply); acceptance is PATCHable via `{replace:[…]}`;
  the read-view checkboxes remain non-interactive because there is no per-item toggle route.
- **`.wiki/gotchas/flat-inputschema-constraint.md:10-12`** — the `update_task.fields` bullet gains:
  its `acceptance` value is itself a nested op object, validated at runtime one level deeper.
- **New `.wiki/gotchas/acceptance-line-round-trip.md`** — the durable, hard-to-re-derive fact: a
  criterion is one `- [ ] <text>` line (`src/taskfile.js:62-63`) and `parse` trims before matching
  (`src/taskfile.js:115-118`), so newline-bearing text silently loses everything after the first
  line and empty-after-trim text vanishes entirely. Records **why** `update_task` refuses both and
  stores trimmed text, **and** that `file_task` is knowingly asymmetric (see below). Cite
  `path:line`, don't paste code. Add the index entry to `.wiki/index.md` under Gotchas in the same
  diff.
- **`conventions/reporting.md`** — **verified no change**: its only mention of acceptance is as a
  `file_task` argument, which is unchanged.

### 7. Sync — no change (explicit finding)

`syncPull` pass B (`src/board.js:1020-1034`) writes winning cards **wholesale** through
`store.writeTask` / `store.moveTask`, never through `updateTask`. Op-based edits therefore have
**no** sync-specific code path. The only interaction is the ordinary one: an acceptance edit bumps
`updated`/`node` via `touch(task)` (`src/board.js:44`, applied at `:533`), making the local card a
normal LWW candidate — exactly as a title edit does. A peer pull can still replace the whole
acceptance list; that is the existing whole-card LWW model and is **correct as-is**.

**Do not change sync semantics.** There is no concrete break to show.

### 8. Knowingly out of scope

- **`file_task`'s looser text handling.** It accepts any string (`src/board.js:286`) — including a
  newline-bearing or empty one — and does not trim. So `update_task` will refuse text that
  `file_task` accepts. This asymmetry is **intentional for this card** (the owner is tracking it
  separately); note it in the new wiki gotcha and **do not fix it here**.
- No new MCP verbs. No change to board state transitions or to the priority/plan/owner surfaces.
  No frontend refactor beyond the edit view. No per-item checkbox toggling in the GUI.

## Refusal table — exact codes and reasons

**Every** row is `INVALID_STATE`, and **every** row returns before `store.writeTask`. `i` is the
op's 0-based position in `ops`; `<op>` is its op name. Every op-level reason **names the offending
op**.

| Trigger | Exact reason string |
|---|---|
| `acceptance` is not an object — array (incl. the natural `string[]` guess), string, number, boolean | `acceptance must be {ops:[…]}, {replace:[…]}, or null` |
| both `ops` and `replace` present | `acceptance takes exactly one of ops or replace` |
| neither `ops` nor `replace` present (e.g. `{}`) | `acceptance takes exactly one of ops or replace` |
| `ops` is not an array | `acceptance.ops must be an array` |
| `replace` is not an array | `acceptance.replace must be an array of strings` |
| an op is not an object (null, string, number, array) | `acceptance.ops[i]: each op must be an object with an op field` |
| unknown `op` value | `acceptance.ops[i]: unknown op "<value>" (add, remove, rename, done)` |
| non-integer `index` on remove/rename/done (`'0'`, `1.5`, `NaN`, absent) | `acceptance.ops[i] (<op>): index must be an integer` |
| out-of-range `index` (`-1`, `length`, any beyond) | `acceptance.ops[i] (<op>): index <index> is out of range (list has <length> items)` |
| non-boolean `done` (`'true'`, `1`, absent) | `acceptance.ops[i] (done): done must be true or false` |
| non-string `text` on add/rename (`42`, `null`, absent) | `acceptance.ops[i] (<op>): text must be a string` |
| `text` contains `\n` or `\r` (add/rename) | `acceptance.ops[i] (<op>): text must not contain a newline` |
| `text` empty after trim (add/rename) | `acceptance.ops[i] (<op>): text must be non-empty` |
| the same three text failures inside `replace` | `acceptance.replace[i]: text must be a string` / `… must not contain a newline` / `… must be non-empty` |

The **first** row is load-bearing: a caller who sends `string[]` (the natural guess, since that is
`file_task`'s form) must learn the right shape from the refusal alone. A reviewer will mutate this
string.

## Tests — behaviour → the test that pins it

Run with `npm test` (`node tests/run.mjs`). Every test opens its own `freshRoot()`
(`tests/_helpers.mjs`) and cleans up — keep that pattern.

### `tests/board.test.mjs` (primary home — the validator lives in `board.js`)

| # | Test | Invariant pinned |
|---|---|---|
| B1 | `acceptance ops resolve against PRE-EDIT indices in a single pass` — 3 items, `ops:[{remove,0},{remove,2}]` → only the middle item survives | **Single-pass resolution.** Kills any walk-and-splice implementation (which deletes 0, then shifts, then hits out-of-range or the wrong item) |
| B2 | `a remove and a rename in one call each hit their pre-edit index` — `[{remove,0},{rename,1,'B'}]` on `[a,b,c]` → `[B,c]` | Rename lands on pre-edit index 1, not the post-remove one |
| B3 | `add appends after survivors, in ops order` — `[{add,'c'},{remove,0},{add,'d'}]` on `[a,b]` → `[b,c,d]` | **Append order.** Kills prepend, insert-at-op-position, reversed appends |
| B4 | `done:false unticks` — tick index 0, then `{done,0,false}` → `done === false` | **Untick reachable.** Kills a truthiness read (`if (op.done)`) and any toggle interpretation |
| B5 | `done:true ticks and survives a re-read` — assert via `readTask` (re-parses the file) | The `- [x]` serializer/parser path |
| B6 | `rename changes text and PRESERVES done` | Kills `next[i] = {text, done:false}` |
| B7 | **One test per refusal-table row.** Each sends the bad `acceptance` **together with a valid `title` change**, then asserts (a) `ok:false`, (b) `code === 'INVALID_STATE'`, (c) the reason matches the exact string incl. the op index/name, (d) **the card is unchanged — the old title AND the old acceptance list**. Pattern to copy: `tests/board.test.mjs:1328` (refused plan) and `:1477` (refused priority) | **Refusal before write, per class.** Clause (d) is the highest-value assertion in the suite: it kills moving the acceptance resolve after the generic loop, and any write-then-validate ordering |
| B8 | `replace preserves done by TEXT, not index` — `[a✔,b]` → `replace:['b','a','c']` → `a` still ✔ at its new position, `b` and `c` unchecked | **Done-flag preservation.** Kills index-based preservation and blanket reset-to-false |
| B9 | `replace trims, and the trimmed value is what matches` — `['  a  ']` against `[a✔]` → text `'a'`, `done:true` | Trim-then-match ordering; kills an untrimmed compare |
| B10 | `replace with duplicate pre-edit texts: the first occurrence's flag wins` | The documented Map rule |
| B11 | `{replace: []} and null both clear the list` | Both clearing paths |
| B12 | `same-index ops are last-write-wins; remove is terminal` — two renames on 0 → later text; `remove` + `rename` on 0 (both orders) → item absent | The documented order rule; guards against a future "helpful" refusal |
| B13 | `an acceptance edit writes NO logbook line` — logbook length identical to the filed card | Owner's no-line decision; kills a stray `logbook.push` |
| B14 | **Extend** `update_task applies whitelisted fields and ignores others` (`tests/board.test.mjs:444`) — `acceptance` now lands while `bogus`/`commit` are still ignored | `acceptance` joined `UPDATABLE` without weakening the ignore-others invariant |

### `tests/routes.test.mjs`

| # | Test | Invariant pinned |
|---|---|---|
| R1 | **Rewrite** `PATCH updates whitelisted fields; acceptance is not editable` (`:129-140`) → `PATCH edits acceptance via {replace}; a bare array is refused`. Asserts `{acceptance:{replace:['y']}}` lands `[{text:'y',done:false}]`, **and** that `{acceptance:[{text:'y',done:true}]}` returns **200** `{ok:false, code:'INVALID_STATE'}` whose reason names all three shapes, with the card unchanged | The deliberate behaviour change (§3) **and** the `{ok}`-envelope rule (a refusal is a normal 200) |
| R2 | `the GUI textarea round-trip keeps ticks` — file `['a','b']`, PATCH `{acceptance:{ops:[{op:'done',index:0,done:true}]}}`, then PATCH exactly what the textarea sends: `{acceptance:{replace:['a','b','c']}}` → `a` still `done:true`, `b`/`c` false | **The GUI PATCH round-trip.** The whole reason `replace` preserves flags |
| R3 | `PATCH {acceptance:null} clears the list` → `[]` | Clearing over HTTP |

### `tests/mcp.test.mjs`

| # | Test | Invariant pinned |
|---|---|---|
| M1 | `update_task acceptance ops over the MCP surface` — `mcp.handle({tool:'update_task', arguments:{project,id,fields:{acceptance:{ops:[…]}}}})` → `{result:{ok:true}}`, then `read_task`'s raw body block contains the expected `- [x]` / `- [ ] ` lines | The nested op object survives the MCP envelope (opaque `fields`, no schema coercion) **and** an edited list still renders as real checkboxes in the raw-text channel |
| M2 | `an acceptance refusal rides in {result:{ok:false}}, not {error}` | The envelope rule for the new refusal class |

### `tests/pluginManifest.test.mjs`

| # | Test | Invariant pinned |
|---|---|---|
| P1 | `update_task advertises the acceptance op shapes` — `fields.description` matches `/ops/`, `/replace/`, `/null/` and each of `add|remove|rename|done`; `properties.fields` still has no nested `properties`. Mirrors the existing `file_task.plan` description test (`:63-73`) | **Advertised surface can't drift from the implemented one**, while the flat-schema constraint stays honoured |

### `tests/taskfile.test.mjs`

| # | Test | Invariant pinned |
|---|---|---|
| T1 | `serializeBody/parse round-trip a renamed + unticked criterion`, including text containing literal `[ ]`-looking characters | An edited list survives the file format |
| T2 | `a newline in criterion text does NOT round-trip` — serialize a `{text:'a\nb'}` item and assert `parse` drops the continuation line | **The documentation-as-test for the newline refusal.** Anyone tempted to relax `cleanAcceptanceText` reads this first |

### `tests/store.test.mjs`

| # | Test | Invariant pinned |
|---|---|---|
| S1 | Extend the mixed-`done` round-trip (`:13-31`): a list whose text was renamed with surrounding whitespace is stored **trimmed** and reads back trimmed | Trim happens before persistence, not on read |

### `tests/sync.test.mjs`

| # | Test | Invariant pinned |
|---|---|---|
| Y1 | `an acceptance-edited card exports its edited list and stays an ordinary LWW candidate` — edit via ops, then `exportBoard`; assert the exported `acceptance` matches and `uid`/`updated`/`node` are present. **No wall-clock comparison** (a same-ms tie would be flaky) | §7's claim is tested, not just asserted in prose — and pass B needs no change |

### Visual verification (required — this is a UX change)

Extend `harness/playwright/snap-gui.mjs`. Card `a` is already seeded with two criteria
(`harness/playwright/snap-gui.mjs:64`). Add to the golden path, and to the numbered list in the
file's header comment:

1. open card `a`'s detail → click **Edit** → screenshot the form with the **Acceptance textarea
   prefilled** one-per-line;
2. edit one line's wording, add a third, **Save** → screenshot the read view showing the renamed
   criterion, the new one, and — if a tick was set first — the tick surviving the round-trip.

Run: `node harness/playwright/snap-gui.mjs`, then **look at** the screenshots in
`harness/playwright/screenshots/`.

## Mutants this plan expects to die

A reviewer will run `/code-mutant:prove` (`harness/mutation/README.md`). These must all be `KILLED`;
if any survives, the gap is in the tests, not the mutant:

| Mutant | Killed by |
|---|---|
| walk-and-splice instead of tombstone | B1, B2 |
| `add` prepends / inserts at the op's position | B3 |
| `if (op.done)` truthiness instead of the explicit boolean | B4 |
| `rename` resets `done` | B6 |
| index bound `<=` length, or `Number(op.index)` coercion instead of `Number.isInteger` | B7 (out-of-range, non-integer) |
| `hasOps \|\| hasReplace` instead of `===` | B7 (both-present, neither-present) |
| resolve acceptance **after** the generic loop, or write before validating | B7 clause (d), every row |
| drop the newline guard / drop the empty-after-trim guard | B7 + T2 |
| preserve `done` by index instead of text; `?? false` → `?? true` | B8 |
| match untrimmed text in `replace` | B9 |
| a stray `logbook.push` on an acceptance edit | B13 |
| weaken the malformed-shape reason string (drop a shape name) | R1 |
| drop `acceptance` from the advertised `fields` description | P1 |

No new standing waivers. The existing two (`ingestPlanFile`'s self-copy guard) are untouched.

## Verification, in order

1. `npm test` — all suites green; report pass/fail with the counters, don't hand it to the user to
   check.
2. `node harness/playwright/snap-gui.mjs` — then **open** the new screenshots and confirm the
   prefilled textarea and the post-save read view render correctly.
3. Spot-check the real MCP surface once (`update_task` with `{ops:[…]}`, then `read_task`) to see
   the checkboxes come back edited over the wire.
4. `git diff master...HEAD` — confirm the docs layer moved with the behaviour:
   `docs/protocol.md`, `docs/features.md`, `.wiki/architecture/gui-seam-contract.md`,
   `.wiki/gotchas/flat-inputschema-constraint.md`, the new
   `.wiki/gotchas/acceptance-line-round-trip.md`, and `.wiki/index.md`.
5. Commit on `code-conductor/33a62f` (never `master`, never push). The message must name the
   deliberate behaviour change: a bare `acceptance` array on PATCH now refuses instead of being
   ignored.

## Decisions I made that the card owner did not specify

1. **Same-index ops are last-write-wins; `remove` is terminal** (order rule 4). The contract's
   refusal table is closed, so a duplicate-index conflict must resolve rather than refuse. Pinned
   by B12.
2. **`{ops: []}` and `{replace: []}` are valid** — an empty `ops` is a no-op success; an empty
   `replace` clears, same as `null`. Pinned by B11.
3. **`replace` preserves ticks by Map lookup, not consumption** — first pre-edit occurrence wins on
   duplicate pre-edit texts; duplicate new texts all inherit the same flag. Pinned by B10.
4. **`acceptance` joins `UPDATABLE`** (rather than living outside it like nothing else does), with
   the generic loop skipping it as it already skips `plan`/`owner`. Keeps `UPDATABLE` the honest
   catalog `docs/protocol.md` describes.
5. **The response does not echo the new list.** `{ok:true}` unchanged; `read_task` is the read path.
6. **The read-view checkboxes stay `disabled`.** No per-item toggle route — `{op:'done'}` covers
   unticking over MCP, and adding one would be scope the card excludes.
7. **`frontend/styles.css` is not touched** — every needed rule already exists (§5).
8. **Pass 1 must not mutate the caller's op objects.** `fields` comes straight from `req.body`;
   normalise into a fresh list instead.
9. **`tests/routes.test.mjs:129-140` is rewritten, not extended** — it currently asserts the
   silent-ignore behaviour this card deliberately removes.
