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

## Decision: the plugin does NOT write git

Moves and edits are **plain atomic filesystem ops** (`store.js`): writes are tmp-file +
`rename`; a move writes the card in the new state dir then unlinks the old. The plugin never
runs `git add`/`git mv`/`git commit` inside `.conduct`.

**Why** (supersedes the earlier plan's `git mv` idea): `.conduct` is the conductor's own git
repo. A second git writer would contend with the conductor's index/commits and risk sweeping
half-staged board changes into unrelated commits. Per-card history already lives in the Logbook;
any git snapshotting of the board is the conductor's concern at its own cadence. This also keeps
git off the core store path (no `git.js` needed).

## Cross-project epics (slug guard + lock key)

A cross-project epic is a top-level `epics/<slug>.md` naming ≥2 member projects in frontmatter
`projects:[…]` (`store.js` `writeCrossEpic`/`readCrossEpic`). Tasks join it by the **same**
`epic:<slug>` field — no task-file change. `board.js` resolves a task's slug to the cross-project
epic iff one covers the task's project, else the project's own epic.

**Slug guard.** `createEpic` refuses `EPIC_CONFLICT` if a slug would be *both* a cross-project epic
and a per-project epic in one of its members — checked in **both** create orders (per-project→cross
and cross→per-project). This keeps every task's `epic` slug unambiguous. (Gotcha: because the two
create paths take **different** locks, a truly-simultaneous per-project + cross create of the same
slug could both pass their guard; tolerable because the conductor is the sole, serial mutator.)

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
