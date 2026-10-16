# Gotcha: the board is a fixed-height flex item and each lane is its own scroller

At `lg` and up the board (`Board` in `frontend/src/components/Board.tsx`) takes the height left
after the epics pane and each lane body scrolls on its own, so a 200-card `done` lane scrolls inside
its lane instead of stretching the page. Four things about that are not re-derivable from the
class lists.

## 1. Offsets survive a reload because the lanes stay mounted

Each lane body is its own scroller, so anything that unmounts or replaces a lane on a reload zeroes
its `scrollTop` and yanks a deep lane back to the top. The lanes are keyed by state and stay mounted
across every refresh, move, edit and filter toggle: `useBoard`'s `reload()` keeps the current lists
on screen while it fetches, and only a project **switch** shows placeholder tiles (inside the
mounted lanes, `pending`). Swapping a lane for a skeleton, keying lanes by index, or clearing the
lists on reload breaks it. `harness/playwright/snap-gui.mjs` step 18 is the proof: set an offset,
Refresh, assert it survived.

## 2. Setting only `overflow-y: auto` gives you a horizontal scrollbar too

`overflow-x`/`overflow-y` are not independent: when one is non-`visible`, the other computes from
`visible` to `auto`. The lane body (`[data-lane-body]` in `Lane`) therefore carries
`overflow-x-hidden` next to `overflow-y-auto`, and `CardTile` carries `[overflow-wrap:anywhere]`, so
a long unbroken title wraps rather than being clipped (or pushing the grid into horizontal page
scroll).

## 3. `lg:flex-1 lg:basis-0` keeps lane content out of the height calculation

A zero basis, not `auto`, is the load-bearing part: with `auto` the lanes' content feeds back into
the board's height and the page stretches. `main` needs `min-h-0` to size below its content at all,
and the lane body needs `min-h-0 flex-1` for the same reason one level down. `lg:min-h-[260px]` is
the short-window floor: below it the board stops shrinking and `main` scrolls the page (step 20c).

## 4. Below `lg` the fixed-height board is off

Below `lg` (1024px) the grid has two lanes per row (one below `sm`), which is three rows: a
viewport-height board would squash each to a third of the screen. The `lg:` prefixes are what switch
the fixed height on, so narrow layouts are content height and the page scrolls (step 20b). On a
phone each lane header is `sticky top-0` within `main`, which pins it at `main`'s content edge
(inside its padding), not its border.

## Where the proof lives

`npm test` never renders React, so none of this is in the unit suite. `snap-gui.mjs` steps 16–20
and 24 assert it: the page fits while the lane overflows, the header's top is unchanged after its
body scrolls, the other lanes stay at offset 0, the offset survives Refresh, the narrow and short
windows scroll the page with no horizontal scroll, and the phone header sticks.

Related: [[../architecture/gui-seam-contract]], [[detail-overlay-close-button-stacking]].
