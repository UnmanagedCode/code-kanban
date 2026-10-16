# Decision: the GUI reads code-conductor's theme from `/pluginTheme.css`

Embedded in code-conductor (cc), the page loads two host URLs at the top of `<head>` in
`frontend/index.html`: the blocking bridge `/pluginBridge.js`, then the stylesheet
`/pluginTheme.css` (cc's palette tokens plus the Geist `@font-face` rules). The bridge mirrors cc's
resolved light/dark onto `<html>` (the `dark` class, and `data-cc-theme`) before first paint and on
every change. The UI never decides the theme itself: no toggle, no `classList` write of `dark`
outside `frontend/public/theme-init.js`.

## Standalone fallback, never re-synced

Standalone (no cc), both host URLs 404. `frontend/public/theme-init.js` then follows the OS
`prefers-color-scheme`, live, and returns early when `data-cc-theme` is present (the bridge owns the
class). The tokens come from `frontend/src/cc-theme-fallback.css`: a one-time snapshot of cc's
token file wrapped in `@layer base`.

- **Never update it to track cc.** cc serves its sheet *unlayered*, and unlayered rules beat any
  `@layer` rule whatever the order, so embedded the snapshot is invisible. It only has to keep the
  page legible standalone.
- `frontend/src/index.css`'s `@theme inline` block is cc's, verbatim (cc's own test compares the
  recipe's block with its own web UI's `index.css`). Plugin CSS goes in an extra `@layer components`
  block only if a utility cannot express it; there is none today.

## Colour only through tokens

Feature code (`frontend/src` outside `components/ui/`) colours only through token utilities
(`bg-card`, `text-muted-foreground`, `text-plan`, …). The copied `components/ui/*` keep the few
literals cc ships (`bg-black/40` dialog overlay, `text-white` on `destructive`).

| Use | Token |
|---|---|
| Lane top border (`LANE_ACCENT` in `frontend/src/lib/board.ts`) | triage `plan`, backlog `info`, todo `primary`, in-progress `warning`, done `success`. Categorical: a hue names a column, not a status |
| Priority badge (`PRIORITY_BADGE`) | CRITICAL `destructive`, HIGH `warning`, MEDIUM `secondary`, LOW `outline`: a ladder, and every judged level badges |
| Owner / plan / cross-project badges | `info` / `plan` / `info` |
| Status line | `ok` → `text-success`, `err` → `text-destructive` |

## Button roles

The variants mean what they mean in cc (code-conductor's `plugin-ui.md` → "What a button variant means"):
`default` is a form's one commit and is `type="submit"` (`SubmitButton`), `ghost` is Cancel and
the toolbar icon button, `outline` is a secondary action (toolbar buttons, Edit, epic Open, Copy).
Every `<button>`/`<Button>` in feature code states its `type`.

## The guards

`tests/frontendTheme.test.mjs`: host URL order in `index.html`; `theme-init.js`'s early return and
live `matchMedia`; the fallback is one `@layer base` block covering every token `index.css` maps (and
every colour token in `.dark`); no literal colour or Tailwind palette utility in feature code; no own
theme toggle; the button-role rule above, over JSX opening tags read by `tests/_sourceScan.mjs`. They
read every script type Vite bundles (`UI_CODE_EXTS`), not only `.ts`/`.tsx`: a `.js` file is bundled
just the same. Each scanner has a liveness floor, and a fixture-tree test that breaks each rule from
a `.js`, `.jsx` or `.mjs` file, so a scan that reads nothing or skips a file type fails.

Related: [[gui-seam-contract]], [[../gotchas/plugin-ui-build-and-csp]], [[../gotchas/detail-overlay-close-button-stacking]].
