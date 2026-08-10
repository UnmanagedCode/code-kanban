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
