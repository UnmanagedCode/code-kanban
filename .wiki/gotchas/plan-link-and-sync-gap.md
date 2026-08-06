# Plan links: the link syncs, the body does not

A card's `plan` is a **link to a plan file**, never the plan text (`src/planLink.js`,
`src/board.js`'s `resolvePlanForSet`). Three things about it are easy to get wrong.

## The link rides sync; the body doesn't

`plan` is in `SCALAR_KEYS` (`src/taskfile.js:13`), so it exports and merges as ordinary
frontmatter under whole-card LWW — no sync code knows about it, exactly like `owner`/`commit`.
Plan **bodies** are not in the dump, so a card pulled from a peer routinely carries a link to a
file this machine does not have. Every surface degrades rather than failing: `read_task` →
`plan_path` set but `plan_missing: true`; `delete_task`'s unlink is a no-op; the GUI renders
"(file not found)". The sharp edge: `update_task` **re-setting that same link** refuses
`PLAN_UNKNOWN`, because set-time validation stats the file. That is correct, and surprising.

Accepted gap, not a bug — see `docs/architecture.md`, "Cross-instance sync".

## `repo:` cannot be set until the plan is merged

`repo:<rel>` resolves under `<PROJECTS_ROOT>/<project>/` — the **base checkout**, deliberately
never a worktree (`src/paths.js`'s `projectRepoDir`). A plan written on a worker's branch does not
exist there yet, so the set refuses `PLAN_UNKNOWN` until the merge lands. Use `board:` for a plan
that must be attachable immediately.

## Frontmatter is one verbatim line, and plans/ is worker-writable

Two guards exist for that, both worth keeping:

- A `\n`/`\r` in a link is refused (`parsePlanLink`) — otherwise the value would inject a spurious
  frontmatter key on write, the same hazard `sanitizeCommit` guards (`src/board.js`).
- After stat, containment is re-checked against `fs.realpathSync` of both the file and its base
  (`safePlanFile` in `src/board.js`). Grammar-level containment alone is not enough: a worker can
  drop a symlink into `plans/`, and `includePlan` would then read straight out of it.
