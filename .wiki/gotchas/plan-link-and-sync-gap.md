# Plan links: the link syncs, the body does not

A `plan` is a **link to a plan file**, never the plan text (`src/planLink.js`, `src/board.js`'s
`resolvePlanForSet`) — on a **card**, and since 2026-0025 on an **epic** too. Four things about it
are easy to get wrong.

## The link rides sync; the body doesn't

`plan` is in `SCALAR_KEYS` (`src/taskfile.js:13`), so it exports and merges as ordinary
frontmatter under whole-card LWW — no sync code knows about it, exactly like `owner`/`commit`.
Plan **bodies** are not in the dump, so a card pulled from a peer routinely carries a link to a
file this machine does not have. Every surface degrades rather than failing: `read_task` →
`plan_path` set but `plan_missing: true`; `delete_task`'s unlink is a no-op; the GUI renders
"(file not found)". The sharp edge: `update_task` **re-setting that same link** refuses
`PLAN_UNKNOWN`, because set-time validation stats the file. That is correct, and surprising.

**Epic plan bodies inherit exactly this gap**, board-level dir included: an epic's `plan` is a
frontmatter scalar that rides whole-epic LWW while its body stays local, so `read_epic` degrades to
`plan_missing: true`. (Its **logbook** is different — that lives *inside* the record and does ship;
see [[cross-instance-sync]] for the LWW consequence.)

Accepted gap, not a bug — see `docs/architecture.md`, "Cross-instance sync".

## `board:`'s base is project-parameterised — and `epic-` in the ingest name is load-bearing

`planBaseDir(project, 'board')` returns `plansDir(project)` for a real project and
`boardPlansDir()` (`<kanbanRoot>/plans/`) when `project` is **null**. Null happens for exactly one
owner: a **cross-project epic**, which has no owning project — the same reason cross epics live
above `projects/`. This is deliberately **not** a third scheme: the owning record's *kind* is
already unambiguous (`createEpic`'s `EPIC_CONFLICT` guard forbids one slug being both, and sync
skips kind conflicts rather than flipping them), so every resolution site already knows which base
it is on and the stored link never has to self-describe. Consequence: `repo:` has no base without
an owning project and is refused `INVALID_STATE` on a cross-project epic. A **project-scoped** epic
keeps using its own project's `plans/` dir — it *has* an owner, its plan sits next to its cards'
plans, and it inherits one sync gap instead of two.

An epic's ingest destination is `plans/epic-<slug>.md`, **not** `plans/<slug>.md`. That prefix is
required, not cosmetic: `SLUG_RE` (`src/board.js`) is `^[a-z0-9._-]+$`, which admits `2026-0001` —
so an unprefixed name would silently **overwrite card `2026-0001`'s own plan file**. Card ids are
always `<year>-<NNNN>` and can never begin `epic-`, so the two namespaces cannot collide. Pinned by
*"an epic ingest cannot clobber a card's plan file when the slug looks like a card id"* in
`tests/board.test.mjs`.

## `repo:` cannot be set until the plan is merged

`repo:<rel>` resolves under `<PROJECTS_ROOT>/<project>/` — the **base checkout**, deliberately
never a worktree (`src/paths.js`'s `projectRepoDir`). A plan written on a worker's branch does not
exist there yet, so the set refuses `PLAN_UNKNOWN` until the merge lands. Use `board:` for a plan
that must be attachable immediately.

## An absolute plan path is INGESTED (copied in) — the tool does it, not the caller

A plan wake hands the conductor a `planPath` under `~/.claude/plans/`
(`code-conductor/src/planFile.ts`), outside `PROJECTS_ROOT`. **No scheme resolves there**, so it can
never be linked in place. It no longer has to be copied by hand: passing that **bare absolute path**
as `plan` (to `update_task`, `file_task` or `create_epic`) makes the tool copy it into the board and
store the resulting `board:` link (`classifyPlanInput` in `src/planLink.js` → `ingestPlanFile` in
`src/board.js`). `ingestPlanFile(destDir, destName, source)` does not know which kind of record it
serves — the caller names the destination, `<id>.md` for a card and `epic-<slug>.md` for an epic.

The rule is uniform, with **no location sniffing** (owner's decision):

- An **explicit scheme** (`board:`/`repo:`) is a **pointer** — stat-validated, never copied, never
  clobbering anything. `board:/abs` still refuses `INVALID_STATE` ("must be relative"): the scheme
  made it a pointer.
- A **bare absolute path** is an **ingest** — always copied, wherever it lives: outside
  `PROJECTS_ROOT`, inside it, inside a worktree, inside `plans/` itself.

Location-based normalisation (absolute-inside-repo → `repo:`) was **rejected**: the absolute paths
actually handed over live in *worktrees*, and `repo:` stats the **base checkout**
(`src/paths.js`'s `projectRepoDir`), so normalising them yields a `PLAN_UNKNOWN` or a link that stays
dead until the merge lands. The cost of always-copying: an absolute path at an in-tree file gives a
**snapshot**, not a live pointer. Pass `repo:<rel>` for the live one — that is the whole distinction
between the two input forms.

Two sharp edges of the copy:

- **The self-copy guard compares REALPATHS, not strings** — and is insurance against *unspecified*
  behaviour, not against a demonstrated bug. `ingestPlanFile` returns a no-op success when
  `fs.realpathSync(source) === fs.realpathSync(dest)`; string comparison would miss the reachable
  second form, an absolute path that is a *symlink* to `plans/<id>.md`.

  **Measured, 2026-08-11 (Node v24.18.0, Linux):** removing the guard does **not** corrupt anything.
  `fs.copyFileSync(dest, dest)` leaves content, size and mtime untouched — `strace` shows libuv
  opening the destination `O_WRONLY|O_CREAT` with **no `O_TRUNC`**, then comparing `st_dev`/`st_ino`
  and returning success without writing. Do not repeat the claim that the file would be zeroed; it
  is false here.

  **Why the guard stays anyway (owner's decision, 2026-08-11):** that short-circuit is a libuv
  internal. Node's `fs.copyFile` docs promise only that an existing destination is overwritten and
  say nothing about a source and destination that are the same file. The failure it guards is
  unrecoverable — in the self-copy case the destination **is** the only copy of the plan — so three
  explicit lines beat depending on a third party's unspecified behaviour.

  **Coverage consequence (waived).** No test can kill the guard's removal on Linux/libuv: with or
  without it, nothing is written. So two mutants are **expected survivors, waived by the owner** —
  *drop the self-copy guard* and *compare `source === dest` as strings instead of realpaths*. Every
  other mutant on this feature still has to die (see `harness/mutation/README.md`). The two tests
  named `…AT the destination…` / `…SYMLINK to the destination…` in `tests/board.test.mjs` pin the
  observable outcome (no-op success, link stored, content intact) and are **not** coverage of the
  guard — do not read them as such.
- **Arbitrary-source read, accepted.** `file_task` is worker-callable, so ingest lets any caller have
  the server copy any readable absolute path into the board and read it back via
  `read_task({includePlan:true})`. Previously the server only read under `plansDir` (realpath-guarded)
  or `projectRepoDir`. Accepted deliberately — workers already have full local fs access and the
  plugin runs as the same user. **No ACL**; do not add one without a new decision.

## Frontmatter is one verbatim line, and plans/ is worker-writable

Two guards exist for that, both worth keeping:

- A `\n`/`\r` in a link is refused (`parsePlanLink`) — otherwise the value would inject a spurious
  frontmatter key on write, the same hazard `sanitizeCommit` guards (`src/board.js`).
- After stat, containment is re-checked against `fs.realpathSync` of both the file and its base
  (`safePlanFile` in `src/board.js`). Grammar-level containment alone is not enough: a worker can
  drop a symlink into `plans/`, and `includePlan` would then read straight out of it.
