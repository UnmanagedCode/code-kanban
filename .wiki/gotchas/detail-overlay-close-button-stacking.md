# Gotcha: the dialog's close ✕ paints over the header's right edge

`DialogContent` (`frontend/src/components/ui/dialog.tsx`) appends its close button after the
children, absolutely positioned `top-4 right-4`. Header content is normal flow, so the positioned ✕
paints above anything placed at the header's right edge, and takes its clicks.

The card detail's Edit button sits there, so `CardDetailDialog`'s `DialogHeader` carries `pr-8`;
every other dialog header carries it too, so a long title wraps before the ✕. Keep that clearance
(or widen it) for any control added to the right of a dialog header.

While a dialog is still loading, the ✕ is its only focusable control, so Radix's opening focus lands
on it and its `focus:ring` shows; that is cc's component behaviour, not a bug here.

Related: [[../architecture/host-theme]].
