# Gotcha: priority tolerance is one-directional (and a mixed-version peer pair diverges)

`priority` was an integer ladder (`0`..`5`, `0` = unset, sorted **ascending** so unset outranked
everything). It is now the four-level enum in `src/priority.js:23` **plus a first-class unset
state** (`null`). The old values did not go away: all 166 live cards were written as `priority: 0`,
and there is **no migration script** — the tolerant parse is the migration.

## The two entry points are deliberately different

| | Function | Rule |
|---|---|---|
| Live caller input (`file_card`, `update_card`, the GUI `PATCH`) | `isPriority` | **Strict**, case-sensitive, exactly the four literals. Anything else → `INVALID_STATE`, validated before any write. `null` is handled separately by the callers as the explicit clear-to-unset token. |
| A value read off disk (`cardfile.parse`, and `cardfile.serialize` on the way back out) | `normalizePriority` | **Tolerant**. Never throws, never drops a card. Anything unrecognised → unset. |

The split is the point: tolerance is a property of *reading data we didn't write*. A card may
predate this build or arrive by sync from an older peer, so we have no choice but to load it. A
live `priority: "URGENT"` has an author who can be told they're wrong, so tell them. Do not
"simplify" by pointing both at `normalizePriority` — that silently swallows caller typos.

Legacy int map (`src/priority.js`): `1→CRITICAL, 2→HIGH, 3→MEDIUM, 4→LOW, 5→LOW`. Everything else —
`0`, a larger int, an unknown word, an empty value, a missing key — is **unset**.

**`0` maps to unset, and this is load-bearing.** `0` meant "never judged", which is exactly what
unset means, so the mapping preserves the value. An earlier build (card `2026-0012`) mapped `0` to
`MEDIUM`; that invented a judgement on all 166 cards, and — because a defaulted `MEDIUM` is
indistinguishable from a deliberate one — invented it invisibly. There is no default anywhere in
this field for the same reason.

Because `parse` coerces on the way in, a loaded legacy card is already holding its true state in
memory — so the first write of any kind (any `update_card`/`move_card`, every sync merge write)
persists the new vocabulary. `serialize` applies the same coercion, but as a guard on a card object
that never came through `parse`, not as what drives the rewrite. An unset card is serialized with
**no `priority:` line at all** (like `epic`/`owner`).

## Mixed-version peers: the value round-trips, the ORDER does not

`priority` is a `SCALAR_KEYS` frontmatter field (`src/cardfile.js:15`) under **whole-card**
last-edit-wins sync, so the value round-trips through whatever build touches the card last.

**Unset survives a round trip.** We write no `priority:` key; a pre-enum peer parses the missing key
as `0` and writes `0` back; we read `0` as unset. Same state, both directions.

**A judged level does not.** Against a peer still on the integer build:

1. We write `priority: HIGH` and the peer pulls the card.
2. The peer parses it with the old `Number.parseInt('HIGH', 10) || 0` → **`0`**, and writes `0` back.
3. We pull that card. It is newer, so LWW takes it wholesale, and our tolerant parse reads `0` as
   **unset**.

So **any card an old peer touches loses its level** — not only legacy cards, but levels a human
deliberately set, with no warning anywhere. This is unavoidable (we cannot change the old build's
parser) and acceptable for a transitional window, but it is exactly the symptom that looks like a
bug in *this* build.

**And even when the value agrees, the ORDER disagrees.** The two builds sort the same unset card to
opposite ends of its column:

| | Unset is stored as | Sorts |
|---|---|---|
| Pre-enum peer | `0`, compared as an ascending integer | **first** — above every judged card |
| This build | `null`, ranked past the last level (`priorityRank`) | **last** — below every judged card |

So the same board viewed on both instances puts unjudged work at the top on one and the bottom on
the other. Nothing is corrupt and no card is lost; the divergence is purely in the read. Reversing
it here is not an option — unset sorting first is the original inversion this field was fixed to
remove.

**If someone reports "my CRITICAL card keeps reverting to unprioritized", or "the two boards
disagree about what's at the top of the column": check whether a sync peer is still on the pre-enum
build. The fix is to upgrade both peers — there is no workaround on this side.**
