# Gotcha: the built UI, its CSP, and what the unit suite can and cannot see

## Built on install, never needed by the tests

- `npm install` runs `prepare` (`vite build --config frontend/vite.config.ts`), which writes
  `frontend/dist/` (gitignored). The host's Library hook is `npm install`, so Install builds and
  Update rebuilds.
- No unit test needs the build. `tests/server.test.mjs` serves a fixture dist from `mkdtemp`
  (`createServer({distDir})`); `tests/dist.test.mjs` checks the real build and **skips** when it is
  absent (a fresh checkout before install, a mutation-harness copy). A fresh clone plus
  `npm install` must run it, not skip it.
- Never cite a path inside `frontend/dist/` in docs or the wiki: `tests/docCitations.test.mjs`
  checks every cited path exists, so such a citation fails every unbuilt tree. Name it in prose
  ("the built `index.html` in `frontend/dist`"); a dedicated test there rejects a `frontend/dist/…`
  citation outright.
- Unbuilt, the server still starts: one `UI not built: … — run npm install` log line at
  `createServer`, then every non-`/api` request is a `text/plain` 503. An install under
  `NODE_ENV=production` / `npm_config_omit=dev` skips the devDependencies, so `prepare` fails and
  the page stays 503 until rebuilt.

## `style-src 'unsafe-inline'` and the rule it creates

`CSP` in `server.js` allows inline styles only because the Radix Dialog's scroll lock injects a
`<style>` element. With it allowed, content must never reach a `style` attribute or element:
injected CSS is live. `tests/frontendSafety.test.mjs` forbids every route a style takes — a
`style=` attribute, a `<style>` element (`createElement('STYLE')` included: the rule ignores
letter case), a `style` key anywhere, bare or quoted (a `React.createElement` props object, an
object spread, and deliberately a type such as `{ style?: string }`: UI source never names a style
key), any `.style` / `['style']` access on an element — in `frontend/src` (the copied
`components/ui/` included), `public/` and `index.html`. It also forbids JSX spread props
(`{...x}`) in the plugin's own components: a spread object can carry `style`,
`dangerouslySetInnerHTML` or an `href` past every attribute rule. Pass props by name; only the
copied `components/ui/` spread.

## Sinks the CSP does not cover

`script-src 'self'` stops an injected inline script, but not navigation: a content-built URL
assigned to `location.href` or passed to `location.assign` / `location.replace` runs a
`javascript:` link regardless. `tests/frontendSafety.test.mjs`'s sink rule therefore also forbids
those, along with `document.cookie`, `parent.postMessage` (cc's frame is same-origin),
`setAttributeNS` and `insertAdjacentElement` next to the raw-HTML and `eval` family. A bare
`Function(` is deliberately not matched (too many false hits); `new Function` is.

Elements are built only as JSX, where the attribute rules can read them. A props object
(`createElement('a', { href: u })`, `jsx(…)`, `cloneElement(el, { href: u })`) would carry any URL
past them, and React itself refuses only `javascript:` on a lowercase `href`, so `data:`,
`//host` and `/api/x` would go through. The names are denied everywhere the guards read (no file
uses them, the copied `components/ui/` included), and so is writing `.href` / `.src` /
`.action` / `.formAction` / `.srcset` onto an element through a ref. The expression-link rule
matches attribute names in any letter case: the DOM folds `HREF={u}` to a live href.

Every guard reads each script extension Vite bundles — `UI_CODE_EXTS` in `tests/_sourceScan.mjs`,
`.mts`/`.cts`/`.cjs` included — so moving code into an unusual extension never takes it out of the
scan; the fixture tree in `tests/frontendSafety.test.mjs` holds one file per extension.

## Pure `lib/*.ts` must stay importable by `node:test`

The tests import `frontend/src/lib/{board,forms,api,persist,acceptanceEdit,planMarkdown}.ts` through Node's
built-in type stripping (unflagged from Node 22.18, hence `engines.node`). So those modules:
- use erasable TypeScript only (no enums, namespaces, parameter properties: `erasableSyntaxOnly`
  in `frontend/tsconfig.json` enforces it at typecheck);
- import each other by relative path with the `.ts` suffix, never the `@/` alias (Vite resolves it,
  Node does not);
- import no DOM or React. Components import them as `@/lib/…`.

## Radix needs a title and a description

Every `DialogContent` renders a `DialogTitle` and a `DialogDescription`, loading and error states
included; without them Radix warns on the console and the harness's console check fails.

## Worktree and scratch-cc traps

- A worktree's `node_modules` may be a symlink into another checkout; `npm install` through it
  writes there. Remove the link (`test -L node_modules && rm node_modules`) before installing.
- Adopting a checkout into a scratch cc lets cc rewrite its `CONVENTIONS.md` / `CLAUDE.md`, which
  dirties the tree. Adopt a scratch `git clone` of the branch, not your working tree.

Related: [[../architecture/host-theme]], [[lane-scroll-container]].
