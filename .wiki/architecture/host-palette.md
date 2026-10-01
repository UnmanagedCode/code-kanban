# Decision: the GUI copies code-conductor's shell palette

The host injects no theme into a plugin iframe, so `frontend/styles.css` carries its own copy of
code-conductor's shell `:root` tokens, font stack and `color-scheme: dark`, taken from the `:root`
block of the host's `public/styles.css`. Token names are the host's own (`--green`/`--amber`/`--red`,
not code-live's `--ok`/`--warn`/`--bad`), so the block diffs cleanly against the host's.

`tests/frontendStyles.test.mjs` pins both the names (`:root declares exactly the host shell tokens
plus the categorical lane hues`) and the values (`shell tokens carry code-conductor's :root
values`). When the host's `:root` changes, re-copy from that file into both the stylesheet and the
test's table; never retype from memory.

## Dark-only
`color-scheme: dark` on `:root` and no `prefers-color-scheme` branch. Without it, native controls
(select popups, checkboxes, scrollbars) render light whenever the OS is in light mode.

## Lane hues are categorical
`--triage`/`--backlog`/`--todo`/`--progress`/`--done` name a column, not a status, so they stay
plugin-local tokens. `--progress` and `--done` alias the host's `--amber` and `--green`. Priority
badges are not categorical: `.badge.prio-critical`/`.badge.prio-high` carry urgency and use host
`--red`/`--amber`.

## Hex literals
Outside `:root` the only hex allowed is the host's own control literals — the quiet-button hover,
the primary hover and the primary ink (`no hex colour outside :root except the host's own control
literals`). Any other colour goes through a token.

## Button roles
- **Accent fill = form submit only.** `button.primary` copies the host's `.uq-submit`, including the
  `:disabled` swap back to panel-2 (`doSyncPull` disables "Pull from peer" while the pull runs).
  `only submit buttons carry the primary class` scans `frontend/app.js` for it.
- **Everything else is quiet** (panel-2, border, host hover). `.ghost` is not transparent: it
  stays in the markup only as a hook — `.epic-row button.ghost` (epic "open", which navigates)
  gets the accent tint, modelled on the host's `.gd-delete` tint pattern.
- `button.danger` takes the host's red tint; nothing in `frontend/` uses it.

## Gotcha: `.overlay-close` hover needs `:not(:disabled)`
The base hover is `button:hover:not(:disabled)` — specificity (0,2,1). A plain
`.overlay-close:hover` is (0,2,0) and loses, so the borderless ✕ grows a hover box. The rule is
`.overlay-close:hover:not(:disabled)` (mirrors the host's `.conductor-caret:hover:not(:disabled)`);
any new borderless button needs the same shape. Same reason `button.primary:hover:not(:disabled)`
and `.epic-row button.ghost:hover:not(:disabled)` exist.

Related: [[gui-seam-contract]], [[../gotchas/detail-overlay-close-button-stacking]].
