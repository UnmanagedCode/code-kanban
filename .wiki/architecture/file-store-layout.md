# File store layout + the no-git-writes decision

## Layout

```
<PROJECTS_ROOT>/.conduct/kanban/
  epics/<slug>.md                              # CROSS-project epic (frontmatter projects:[…])
  projects/<project>/
    triage/ backlog/ todo/ in-progress/ done/  # <id>.md per task, one per column dir
    epics/<slug>.md                            # project-scoped epic
```

A task's **state is its directory** — never stored in the file; `store.js` injects it on read.
Task files: minimal `---` frontmatter (`id, title, project, epic?, priority, created, owner?,
depends_on`) + `## Goal`, `## Acceptance` (checkboxes), `## Logbook` (append-only). Parsed by
`src/taskfile.js` (hand-rolled, no YAML dep).

## Decision: the plugin does NOT write git (but does one narrow read)

Moves and edits are **plain atomic filesystem ops** (`store.js`): writes are tmp-file +
`rename`; a move writes the card in the new state dir then unlinks the old. The plugin never
runs `git add`/`git mv`/`git commit` inside `.conduct`.

**Why** (supersedes the earlier plan's `git mv` idea): `.conduct` is the conductor's own git
repo. A second git writer would contend with the conductor's index/commits and risk sweeping
half-staged board changes into unrelated commits. Per-card history already lives in the Logbook;
any git snapshotting of the board is the conductor's concern at its own cadence.

This decision is scoped to `.conduct`, not to git entirely: landing a task (`move_task` to
`done`) does one narrow **read** — `git rev-parse HEAD` (`src/git.js:headSha`) — to stamp a
`commit` field on the task. It never touches `.conduct` and never writes.

**Crucially, that read targets the owning worker's live working directory, never the base
project checkout.** A worker typically runs on a git *worktree* (its own branch, e.g.
`code-conductor/<hash>`); its commits aren't in the base checkout's history until a merge, so
reading the base checkout's HEAD would silently stamp the wrong sha. Instead, `moveTask` captures
the task's prior (`in-progress`) `owner` sessionId *before* it's cleared, and resolves it to a
live working directory via `src/ownerWorktree.js:ownerCwd` — which calls the conductor's
`GET /api/instances` (the same `CONDUCTOR_URL` HTTP channel `projects.js` uses for `/api/projects`)
and reads the matching instance's `cwd` (the worktree path, or the base checkout if the worker
wasn't in a worktree). If the owner can't be resolved this way (no `CONDUCTOR_URL`, or the
session has aged out of the conductor's in-memory instance registry — e.g. already torn down
before landing), `commit` is simply left unset unless the caller passed one explicitly. Never a
hard failure.

## Cross-project epics (slug guard + lock key)

A cross-project epic is a top-level `epics/<slug>.md` naming ≥2 member projects in frontmatter
`projects:[…]` (`store.js` `writeCrossEpic`/`readCrossEpic`). Tasks join it by the **same**
`epic:<slug>` field — no task-file change. `board.js` resolves a task's slug to the cross-project
epic iff one covers the task's project, else the project's own epic.

**Slug guard.** `createEpic` refuses `EPIC_CONFLICT` if a slug would be *both* a cross-project epic
and a per-project epic in one of its members — checked in **both** create orders (per-project→cross
and cross→per-project). This keeps every task's `epic` slug unambiguous. The guard is effectively
global even though the two create paths take **different** locks (project mutex vs the cross key):
each guard-check-then-write runs **synchronously inside its lock callback** — no `await` between the
read and the write — so on Node's single thread the two can't interleave; whichever commits first,
the other sees it and refuses. **Gotcha:** adding an `await` between the guard read and the write
inside either lock callback would reopen this window — keep those critical sections synchronous.

**Lock key.** Cross-epic writes serialize under `withLock(' cross-epics')` — a sentinel key with a
leading space, which `projects.NAME_RE` forbids, so it can never collide with a project mutex. This
is the *same* single-writer mechanism keyed on a different domain, **not** a second write path: it
does not touch per-project task/epic files, so invariant #1 in [[overview]] holds.

## ID sequence (year rollover)

`nextId` = `${currentYear}-${NNNN}` where `NNNN` = `max numeric suffix across all of the
project's cards + 1`. The sequence is **project-wide monotonic and does NOT reset per year** —
ids stay globally sortable and gap-free within a project; the year is a human-readable creation
prefix only. Assignment happens inside the project mutex, so concurrent `file_task` calls never
collide.
