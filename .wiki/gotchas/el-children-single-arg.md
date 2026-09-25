# Gotcha: `el()` takes children as ONE argument

`el` in `frontend/app.js` is the GUI's only DOM builder, with the signature
`(tag, props = {}, children = [])`. `children` is a **single** argument: a node, a string, or an
array of them. It is normalised with `[].concat(children)`, and `null`/`false` entries are skipped.

- **A 4th or later positional argument is silently dropped.** No error, no warning. The node just
  renders without it. `el('span', {}, 'tr: ', el('b', {}, '1'))` renders `tr: ` with no count.
  Pass several children as an array: `el('span', {}, ['tr: ', el('b', {}, '1')])`. Every caller in
  `frontend/app.js` does this, `renderRollup` included.
- **Nested arrays are not flattened.** `[].concat` flattens only one level, so an inner array
  reaches `String(c)` and renders as comma-joined text. Don't make `el` variadic
  (`...children`): every existing array caller would become `[[a, b]]` and break unless `el` also
  switched to `.flat()`.
- **Only the Playwright harness catches it.** `npm test` (`tests/run.mjs`) never loads
  `frontend/app.js`. `harness/playwright/snap-gui.mjs` step 23 pins the rollup pills' exact
  `label: N` text on both the epics pane and the epic detail panel.
