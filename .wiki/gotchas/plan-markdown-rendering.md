# Gotcha: plan bodies render as Markdown through an in-house parser, and every byte is hostile

The Plan section (card and epic detail, `frontend/src/components/PlanSection.tsx`) renders the plan
file as Markdown. The plugin page is same-origin with code-conductor, unsandboxed, and `/api/*` has
no auth: any script that runs here can spawn sessions and run bash. A plan is model-written, so the
renderer treats it as an attacker's input.

## Why no Markdown library

- `package-lock.json` is untracked, so every install resolves dependencies fresh, and devDependencies
  are bundled into the page. react-markdown + remark-gfm is roughly 70 transitive packages,
  markdown-it about 6; one compromised release is a host compromise.
- A library's internals are invisible to `node tests/run.mjs`, the mutation harness and the
  worker-deadline timing tests. A pure `frontend/src/lib/planMarkdown.ts` is graded by all three.
- `tests/frontendSafety.test.mjs` forbids expression `href`s and JSX spreads; library `components`
  overrides are idiomatically spreads. The in-house renderer needs exactly one guarded `href` sink.

Two extensions over CommonMark, both because real plans rely on them:
- **YAML frontmatter.** Most plan files open with a `---` / `key: value` / `---` block. Read as
  CommonMark it is a rule, the keys soft-wrapped into one run-on paragraph, and another rule. So
  `parsePlan` takes line 0 exactly `---` through the next line exactly `---` as one verbatim `code`
  block (no new node kind: the vocabulary stays closed). Only that exact, closed pair at line 0
  counts; an unclosed opener, a leading blank line or `--- ` / `----` parse as before. One
  `indexOf` for the closer, so the scan stays linear (`frontmatterUnclosed` in the timing suite).
- **A table straight after paragraph text.** `Expected results:\n| a | b |\n|---|---|` is a
  paragraph then a table: a header row whose next line is a matching delimiter row ends the
  paragraph (the paragraph loop checks `tableAt` on every continuation line). GFM's reference
  implementation does the same; plans lean on it.

The price is fidelity: not CommonMark-complete. The deviations (also listed for users in
`docs/features.md`, "Plan Markdown"): no setext headings (`---` is always a rule), no indented code
blocks, no reference links, autolinks or bare-URL linkify, no entity decoding, no hard breaks but
`<br>`. The **Raw** toggle is the escape hatch for every gap.

## The security shape (what the tests pin)

- **No HTML channel.** `parsePlan` returns plain data in a closed vocabulary — blocks
  `heading | paragraph | code | list | quote | table | hr`, inlines
  `text | code | strong | em | del | link | br` — and `PlanMarkdown.tsx` maps each kind to one fixed
  element with text children. There is no image and no html node, so neither can render. A `<tag>`
  is text; plans are full of `<id>`/`<slug>` placeholders that must stay visible.
- **`<br>` is a token, not passthrough.** Exactly `<br>`, `<br/>`, `<br />` (any case) become a
  `br` node rendered attribute-less; `<br onclick=…>` stays text. It exists because plans use it in
  table cells.
- **`safeHref` uses the WHATWG `URL` parser with no base** — the algorithm the browser applies to
  `<a href>`, so there is no parser differential (leading C0/space stripping, tab/newline removal
  and case folding all happen identically). Only an absolute `http:`/`https:`/`mailto:` URL passes,
  returned as `url.href`. A relative URL is refused rather than resolved against the plugin origin.
  A refused link renders its whole `[text](url)` source as text: nothing is hidden.
- **Images are never loaded.** `![alt](url)` renders its source; a remote `<img>` would be a
  tracking/exfiltration beacon. The harness asserts no request reaches the beacon URL.
- **One `href` sink.** `PlanMarkdown.tsx` is `LINK_HOME` in `tests/frontendSafety.test.mjs`: there
  only, an href written exactly `href={safeHref(<one name>)}` is exempt from the expression-link rule
  (re-checking at the sink). The exemption is deliberately narrower than "starts with
  `safeHref(`": `href={safeHref(u) || u}` would pass an unchecked URL, so it trips. The file must
  import `safeHref` unaliased from `@/lib/planMarkdown`, and every other `safeHref` in it must be
  the call at an `href={…}` sink. The count check (`linkHomeOffences`) is what rules out a
  shadowing binding: a parameter, destructured parameter or arrow parameter named `safeHref` would
  satisfy the sink's shape while calling something else. The sink match is case-sensitive on
  `safeHref` for the same reason. Every `<a>` in
  feature code must carry the literal `target="_blank" rel="noopener noreferrer"`: a new top-level
  context can never navigate the host frame, and gets no `window.opener` and no Referer.
- **Name a prop `action` and the guard fires.** The expression-link rule also guards `<form action>`,
  so any JSX `action={…}` trips it; that is why `DetailSection`'s head-row slot is `aside`.

## Linear time, bounded depth

The parser runs on the UI thread. Techniques (see `.wiki/gotchas/linear-line-parsers.md` for the
regex trap they avoid):
- Lines split on `\n`, one trailing `\r` stripped, a final empty line dropped (it would land in an
  unclosed fence); every block test scans by index.
- Quote/list containers nest at most `MAX_NEST` deep; deeper markers stay paragraph text. Each
  level re-reads its lines once, so the cost is O(n·`MAX_NEST`).
- Inlines are one left-to-right pass over an output stack. An opener is pushed as a literal text
  node; a closer replaces the stack from its opener up with one wrapper. A wrap always takes a
  suffix, so openers below it keep their indices, and the suffix-maximum stack (`peaks` in
  `parseInline`) answers "how deep is everything above this opener" in O(log n). That is what
  enforces `MAX_INLINE_NEST` without rescanning: deeper matches stay literal.
- One opener stack per delimiter type (`*`, `**`, `_`, `__`, `~~`); a closer takes the top of its
  own stack and drops every other opener above it. Runs of 4+ `*`/`_`, and `~` runs other than 2,
  are literal. `_` never opens or closes intraword (`file_card_x`).
- A code-span closer comes from a per-length index of backtick runs whose pointers only advance.
- A link destination scan after `](` stops at whitespace, `(` or `)`, so successive scans never
  overlap. Making a link empties the bracket stack: no links in links.
- **Table rows are cut to the header width but never padded.** Padding makes the AST header width ×
  row count — a 64 KiB plan with thousands of columns and thousands of one-cell rows would build
  over a hundred million cells. A short row renders with fewer cells.

`tests/planMarkdown.test.mjs` pins the vocabulary, the allowlist, each construct and both caps;
`tests/parserTiming.test.mjs` runs each hostile shape at two sizes 8x apart, alternating and keeping
each size's fastest run, and bounds both the larger run's time and the growth (linear about 8x,
quadratic 64x). The ratio is what makes a quadratic regression fail on any machine: the code-span
closer pointer, reset to 0, still parses the backtick-pair shape under 2 s at 200 000 characters.
The caps are pinned at link depth as well as emphasis depth (a link whose text is already
`MAX_INLINE_NEST` deep stays literal), and at the list dispatch itself (`- a` at the container cap).

## Rendering notes

- Heading level L renders as `h{min(6, L+3)}`: the Plan section sits under an `h3`.
- The Markdown body is a block-flow scroll box (`space-y`), not a flex column: in a height-capped
  flex column, a fence or table wrapper with `overflow-x-auto` shrinks to a sliver. The harness
  asserts no fence or table is clipped.
- The view is `useState` only, never `persist.ts`: Radix unmounts `DialogContent` on close, so every
  open starts in Markdown (the harness checks it).

Related: [[linear-line-parsers]], [[plugin-ui-build-and-csp]], [[../architecture/gui-seam-contract]].
