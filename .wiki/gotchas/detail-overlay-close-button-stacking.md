# Gotcha: `#detail-overlay`'s close button always paints over `.detail-head`

`.overlay-close` (the close button inside `#detail-overlay` in `frontend/index.html`) is static markup that sits *before* `#detail-body`
in the DOM, absolutely positioned at `top:10px; right:12px` relative to `.overlay-card`
(`.overlay-close` in `frontend/styles.css`). Content injected into `#detail-body` — e.g. `.detail-head`
(built by `openDetailNode` in `frontend/app.js`) — is normal static flow, so per CSS stacking rules the positioned
close button always paints *above* it regardless of DOM order, even though `.detail-head`
comes later in the document.

Consequence: any button placed at the right edge of `.detail-head` (e.g. the card-detail Edit
button) will visually collide with, and have its clicks intercepted by, the close button unless
`.detail-head` reserves clearance. Fixed via `padding-right: 28px` on `.detail-head`
(`.detail-head` in `frontend/styles.css`) — keep that clearance (or increase it) if `.detail-head`'s content
grows.
