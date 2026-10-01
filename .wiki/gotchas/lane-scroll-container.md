# Gotcha: the board is a fixed-height flex item and each lane is its own scroller

`.board` is a fixed-height flex item and each `.column-body` scrolls on its own, so a 200-card
`done` lane scrolls inside its lane rather than stretching the page. With `main` as the only
scroller and content-sized lanes (`align-items: start`), that lane would stretch the whole page and
you would scroll past every other lane header to reach it. Four things about that are not re-derivable from reading the CSS.

## 1. `renderBoard`'s `replaceChildren()` zeroes every lane's `scrollTop`

`renderBoard` in `frontend/app.js` rebuilds **every** lane on every load, move, edit and filter
toggle. That destroyed the lane elements before too, but it was invisible: the *page* scrolled and
the browser kept `main`'s offset. Once lanes scroll independently, the same rebuild silently yanks a
deep `done` lane back to the top on every refresh.

So the offsets are captured into a `Map` **keyed by `data-state`** (not DOM position, so it survives
a change in lane count or order) before `replaceChildren()`, and restored in a second pass **after**
`board.append(col)` — a `scrollTop` write on a detached element is a silent no-op, so restoring
inside the build loop does nothing at all. `harness/playwright/snap-gui.mjs` step 18 is the proof:
set an offset, click Refresh, assert it survived.

## 2. Setting only `overflow-y: auto` gives you a horizontal scrollbar too

`overflow-x`/`overflow-y` are not independent: if one is set to a non-`visible` value, the other
computes from `visible` to `auto`. Setting just `overflow-y: auto` on `.column-body` therefore puts
a *horizontal* scrollbar inside every lane. `.column-body` in `frontend/styles.css` pins
`overflow-x: hidden` explicitly for that reason — and the `.card` rule there carries
`overflow-wrap: anywhere` so a long unbroken title wraps rather than being clipped by it (and so
it can no longer push the grid's min-content width into horizontal *page* scroll).

## 3. `flex: 1 1 0` on `.board` is what keeps lane content out of the height calculation

`flex-basis: 0` — not `auto` — is the load-bearing part (`.board` in `frontend/styles.css`). With `auto` the
lanes' own content feeds back into the board's height and the page stretches again, which is the bug
being fixed. It needs `min-height: 0` on `main` (the `main` rule in `frontend/styles.css`) to be allowed to size
below content at all, and `min-height: 0` + `flex: 1 1 auto` on `.column-body` for the same reason
one level down: a flex child will not shrink below its content without it, so the lane just grows
and nothing scrolls.

`.board`'s `min-height: 260px` is the **short-window floor**: below it the board stops shrinking and
`main`'s `overflow: auto` scrolls the page again, exactly as it did before per-lane scrolling. That
fallback is deliberate, not a leftover — it is what keeps every card reachable on a 420px-tall
window (`snap-gui.mjs` step 20c).

## 4. The fixed-height board is opted OUT below 980px

At `max-width: 980px` the grid reflows to two lanes per row, which means **three grid rows** — a
viewport-height board would squash each row to a third of the screen. That media query resets
`flex: 0 0 auto; min-height: 0; align-items: start` (its `.board` rule in `frontend/styles.css`), so narrow layouts
go back to content height and page scrolling; `.column-body`'s `overflow-y` then never fires,
because nothing constrains the lane's height. The `max-width: 620px` block inherits the opt-out.

## Where the proof lives

`npm test` has **no DOM environment** (no jsdom, no playwright in `package.json`), so none of the
above is covered by the unit suite. `harness/playwright/snap-gui.mjs` steps 16–20 assert it and
throw: the page fits while the lane overflows, the lane header's `getBoundingClientRect().top` is
unchanged after scrolling its body, the other lanes stay at offset 0, the offset survives Refresh,
and neither the narrow nor the short window scrolls horizontally. Run:
`node harness/playwright/snap-gui.mjs`.

Related: [[../architecture/gui-seam-contract]], [[detail-overlay-close-button-stacking]].
