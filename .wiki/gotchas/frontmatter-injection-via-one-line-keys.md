# Gotcha: every frontmatter key is ONE line — caller text with a newline injects sibling keys

`cardfile.serialize` (`src/cardfile.js`) writes each scalar as one `key: value` line, and
`cardfile.parse` reads the frontmatter block **line-by-line**. So a newline in a caller-supplied
value does **not** truncate on the next read: the text after it becomes **sibling frontmatter
keys**, and the caller sets fields the field they used never granted. This is the frontmatter-layer
twin of [[acceptance-line-round-trip]] (a criterion is one `- [ ] …` line in the body).

Card `2026-0033` closed this for a card's `title`, in `checkTitle` (`src/board.js`) — the validator
`fileCard` and `updateCard` share, so both surfaces closed at once.

## The parse rule that decides what sticks: last-wins on a duplicate key

Injected lines land immediately **after** the key that carried them, so whether the injection or
the genuine value wins depends on where `serialize` writes that genuine key relative to the carrier.
For a `title`-borne injection, measured on `8f9dff58` (pre-fix):

- **Serialized ABOVE `title` → the injection always wins.** `id`, `uid`. A card whose file is
  `2026-0001.md` parsed back as `id: 9999-9999` and `uid: HIJACKED-UID`. **`uid` is the
  cross-instance sync match key** ([[cross-instance-sync]]) and is served by `/api/sync/export`, so
  this is the severe pair — and the one the card text omitted.
- **Serialized BELOW `title` but only when truthy → the injection wins when the card's own value is
  unset.** `epic`, `priority`, `owner`, `commit`, `plan`. All five measured sticking on a fresh card.
- **Serialized BELOW `title` unconditionally → the genuine value wins.** `project`, `created`,
  `depends_on`. Overwritten on the same parse.

The injected keys **survive a subsequent unrelated `update_card`** — they are re-serialized from the
parsed values — so an injection was durable, not a one-read artefact.

**Confirmed negative:** an injected `plan:` link is *dangling, not an arbitrary read*. Read-time
containment holds — `plan: board:../../../../../../etc/hostname` comes back `plan_path: null,
plan_missing: true` at both `read_card` and `read_epic` ([[plan-link-and-sync-gap]]). The severity
is data integrity and privilege confusion, not disclosure.

Parser-side: `parse` only assigns keys it knows (`SCALAR_KEYS`, plus `depends_on`/`priority`). An
unknown injected key is silently dropped on read, i.e. harmless.

## The rule: refuse caller prose, sanitize machine tokens

The repo's line is drawn by the **provenance of the value**, not by convenience:

- **Caller-authored text bound for a one-line slot → REFUSED** with `INVALID_STATE`.
  `checkTitle` and `cleanAcceptanceText` (`src/board.js`) both test `/[\n\r]/` on the **raw** value
  (so `'a\n'` and `'\na'` are refused too, before any `trim()`); `classifyPlanInput`
  (`src/planLink.js`) refuses a newline naming this exact hazard; `updateCard`'s `owner` guard
  refuses any whitespace.
- **Machine-derived tokens → SANITIZED.** `sanitizeCommit` takes the first line, because its input
  is a sha that may arrive with a trailing newline from git, and it degrades to `''` (no commit)
  rather than to a *wrong* commit.

Stripping or space-joining caller prose would persist `"a priority: CRITICAL"` — a title the caller
never wrote — while still answering `{ok:true}`: the caller gets no signal, which is the failure
mode `resolveListForSet`'s comment already rejects for coercion. Trimming is safe because it is
semantically idempotent; collapsing a newline is not. **Do not extract a shared newline predicate:**
the three call sites each carry their own message and surrounding semantics, and `/[\n\r]/` inline
is the established idiom.

## Audit — every one-line key `cardfile.serialize` writes

"Reachable" = a newline can arrive from caller input at `file_card`/`update_card` and land in the
file. Order as serialized.

| key | caller-settable? | guard | reachable with a newline? |
| --- | --- | --- | --- |
| `id` | no (`store.nextId`) | n/a | not directly — but injectable *via* a carrier key above it. Closed for `title`. |
| `uid` | no (`crypto.randomUUID()`) | n/a | same as `id`. |
| `title` | yes, both mutators | `checkTitle`: type, non-empty-after-trim, **and no `/[\n\r]/`** | no — closed by `2026-0033` |
| `project` | yes, validated | `requireProject` + `projects.NAME_RE` | no |
| `epic` | yes, both | `checkEpic` (shape: non-empty string, or `null`) **then** `epicVisibleIn` (slug must name a record; `createEpic` gates slugs on `SLUG_RE` `^[a-z0-9._-]+$`) | no — but this row's safety rested on a gate that only ran for TRUTHY values until `2026-0032`; see [[update-card-verbatim-fields]] |
| `priority` | yes, both | `isPriority` enum, exact match | no |
| `created` / `updated` / `node` | no (`nowIso()`, `localNodeId()`) | n/a | no |
| `owner` | yes at `update_card`, `move_card` | `/\s/` refused (covers `\n`/`\r`) | no |
| `commit` | yes at `move_card` | `sanitizeCommit`: first line, then `/\s/` → `''` | no |
| `plan` | yes, both | `classifyPlanInput` refuses `/[\n\r]/` | no |
| `depends_on` | yes, both | `resolveDependsOnForSet`: array + `typeof === 'string'` only | **YES — open, card `2026-0034`** |

## Two open follow-ups and one accepted risk

- **`2026-0034` — `depends_on` items.** `serializeDependsOn` writes the whole list on one line
  (`[a, b]`) and only string-ness is checked. Verified pre-fix:
  `file_card({depends_on:['x\npriority: CRITICAL\nowner: dep-hijack']})` → `ok:true`, and the next
  parse yields `priority:"CRITICAL"`, `owner:"dep-hijack]"`. Deliberately **not** folded into
  `2026-0033`: the honest rule for a dependency id is *id-shaped* (`^\d{4}-\d{4}$`), not
  *no-newline*, and a dangling-but-well-formed id is tolerated by design (`syncPull`'s
  `translateDeps`), so the guard must be a shape check and not an existence check.
- **`2026-0035` — `create_epic`'s title.** `store.serializeEpicFile` writes `title:` as its second
  line; `createEpic` has its **own** inline check (`'title is required'` — a different string from
  `checkTitle`'s) with no newline guard. Verified pre-fix:
  `create_epic({project:'demo', slug:'ep', title:'a\nplan: board:hijack.md'})` → `ok:true` and
  `read_epic` returns that plan link — an injection that **bypasses `resolvePlanForSet`'s stat and
  containment check entirely**, which is strictly worse than the card-side hole.
- **`sync_pull` — accepted, no card.** `syncPull`'s card path validates only `typeof rc.id ===
  'string'` and a known `state` before writing an incoming card, so `title`/`epic`/`owner`/`commit`/
  `plan` land verbatim from the peer and a hostile peer injects the same way. Mitigating: the pull is
  a deliberate operator-initiated two-click action against a chosen peer, and the **no-auth trust
  model** is a recorded decision ([[cross-instance-sync]]). Epics already get a
  `normalizeRemoteEpic` pass while cards deliberately do not; the card-side `goal` hole is tracked as
  `2026-0026`, and hardening cards to epic parity belongs there, not in a new card.
