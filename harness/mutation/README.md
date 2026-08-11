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

Waiver reason to record: *"owner 2026-08-11: guard kept as insurance against libuv's UNSPECIFIED
same-inode behaviour (node's fs.copyFile docs promise nothing about it) on an unrecoverable path —
the destination is the only copy of the plan. Behaviourally unobservable on Linux/libuv, so no test
can kill it. See .wiki/gotchas/plan-link-and-sync-gap.md."*

Everything else on that feature must die — notably: drop the `mkdirSync`; `renameSync` instead of
`copyFileSync`; name the destination from the source basename; skip the copy when the destination
exists; ingest a `board:`/`repo:` pointer; treat a bare relative path as an ingest; set `task.plan`
before the source is validated; write the card before the copy in `fileTask`.

## `--jobs` and parallel copy runs

`--jobs N` in `copy` mode is safe for this project. Verified 2026-08-10 as part of
code-mutant cards 2026-0010 / 2026-0029.

**What was wrong.** A `--jobs 4` `/code-mutant:prove` run against this project returned two
verdicts a serial re-run contradicted: `norm-zero-medium-str` as `SURVIVED` (11/0/0, re-ran alone as
`KILLED`), and `filetask-null-refused` as `IMPRECISE` with spurious failures including a
`seedRawCard` test that never calls `fileTask`. A full `--jobs 1` run was clean: 12 mutants, 12
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
build/package cache, or depends on the checkout's absolute path. None applies: `routes.test.mjs` is
the only file that binds a port, and it does so via `server.listen(0, '127.0.0.1', ...)` — port `0`,
so the OS assigns an ephemeral port per copy and concurrent runs can't collide. The six test files
that touch disk (`nodeId`, `mcp`, `store`, `routes`, `sync`, `board`) each open their own
`fs.mkdtemp(os.tmpdir())` board root via `tests/_helpers.mjs::freshRoot`; the remaining four
(`persist`, `taskfile`, `pluginManifest`, `priority`) are pure-function tests with no filesystem
access at all. The only `preserve` entry is `node_modules`, which the suite only reads. That last
point is the one to re-check if `preserve` ever grows: **`preserve` entries are symlinked into every
copy**, so a preserved path is shared writable state across all workers *and* this checkout.

Re-verify before trusting a parallel verdict: a `--jobs N` run whose findings a `--jobs 1` re-run
contradicts is a code-mutant bug, not a coverage finding, and should be reported upward.
