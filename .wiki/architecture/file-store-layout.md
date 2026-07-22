# File store layout + the no-git-writes decision

## Layout

```
<PROJECTS_ROOT>/.conduct/kanban/projects/<project>/
  triage/ backlog/ todo/ in-progress/ done/   # <id>.md per task, one per column dir
  epics/<slug>.md
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

## ID sequence (year rollover)

`nextId` = `${currentYear}-${NNNN}` where `NNNN` = `max numeric suffix across all of the
project's cards + 1`. The sequence is **project-wide monotonic and does NOT reset per year** —
ids stay globally sortable and gap-free within a project; the year is a human-readable creation
prefix only. Assignment happens inside the project mutex, so concurrent `file_task` calls never
collide.
