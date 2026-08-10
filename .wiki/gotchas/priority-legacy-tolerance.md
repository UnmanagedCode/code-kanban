# Gotcha: priority tolerance is one-directional (and a mixed-version peer pair loses levels)

`priority` was an integer ladder (`0`..`5`, `0` = unset, sorted **ascending** so unset outranked
everything). It is now the four-level enum in `src/priority.js:20`. The old values did not go away:
all 166 live cards were written as `priority: 0`, and there is **no migration script** — the
tolerant parse is the migration.

## The two entry points are deliberately different

| | Function | Rule |
|---|---|---|
| Live caller input (`file_task`, `update_task`, the GUI `PATCH`) | `isPriority` | **Strict**, case-sensitive, exactly the four literals. Anything else → `INVALID_STATE`, validated before any write. |
| A value read off disk (`taskfile.parse`, and `taskfile.serialize` on the way back out) | `normalizePriority` | **Tolerant**. Never throws, never drops a card. |

The split is the point: tolerance is a property of *reading data we didn't write*. A card may
predate this build or arrive by sync from an older peer, so we have no choice but to load it. A
live `priority: "URGENT"` has an author who can be told they're wrong, so tell them. Do not
"simplify" by pointing both at `normalizePriority` — that silently swallows caller typos.

Legacy int map (`src/priority.js`): `1→CRITICAL, 2→HIGH, 3→MEDIUM, 4→LOW, 5→LOW`. Everything else —
`0`, a larger int, an unknown word, an empty value, a missing key — is `MEDIUM`. `0` is
deliberately absent from the map: it meant "unset", and unset is now MEDIUM.

`serialize` normalises too, so a legacy card is rewritten in the new vocabulary the first time
anything writes it (any `update_task`/`move_task`, and every sync merge write).

## The one-directional trap: an old peer silently degrades levels to MEDIUM

`priority` is a `SCALAR_KEYS` frontmatter field (`src/taskfile.js:15`) under **whole-card**
last-edit-wins sync, so the value round-trips through whatever build touches the card last.
Against a peer still on the integer build:

1. We write `priority: HIGH` and the peer pulls the card.
2. The peer parses it with the old `Number.parseInt('HIGH', 10) || 0` → **`0`**, and writes `0` back.
3. We pull that card. It is newer, so LWW takes it wholesale, and our tolerant parse reads `0` as
   **`MEDIUM`**.

So **any card an old peer touches reverts to MEDIUM** — not only legacy cards, but levels a human
deliberately set, with no warning anywhere. This is unavoidable (we cannot change the old build's
parser) and acceptable for a transitional window, but it is exactly the symptom that looks like a
bug in *this* build.

**If someone reports "my CRITICAL card keeps reverting to MEDIUM": check whether a sync peer is
still on the pre-enum build. The fix is to upgrade both peers — there is no workaround on this
side.**
