import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, proseFiles } from './_prose.mjs';

// 2026-0028 — every in-repo file path cited by the prose layers must resolve to
// a file that exists.
//
// SCOPE, and the limits are the point.
//
// 1. This closes PATH EXISTENCE only. It does NOT check that a `path:line`
//    citation points at the line it claims — that needs the cited symbol, which
//    no generic test can know. Card 2026-0028 fixed four such stale line numbers
//    by hand (SCALAR_KEYS, file_card's acceptance mapping, .detail-head, and a
//    wiki plan-link cite) and card 2026-0030 carries the rest. So a green run
//    means "no dangling paths", never "citations are accurate".
// 2. `plans/` is DELIBERATELY not scanned, and no citation INTO it is extracted
//    (it is absent from both PROSE_ROOTS and CITATION_RE's prefix group). A
//    landed plan is a dated record: it names files as they were called when it
//    was written, so a moved or deleted module is expected to dangle there and
//    would be noise, not a finding. Same reasoning that kept `plans/` out of the
//    2026-0028 rename sweep.
//
// Why it exists: the task -> card rename moved src/taskfile.js, and the docs and
// wiki cite module paths constantly. A missed citation is invisible to every
// other gate in the suite — nothing imports a doc — so it would have shipped as
// a dead pointer. The one-shot shell sweep that caught it during the rename is
// codified here so the class stays closed.


// Directory prefixes that name THIS repo's tree. A citation must start with one
// to be checked at all, which is what keeps bare prose words out.
const CITATION_RE = /\b(?:src|tests|frontend|harness|docs|conventions)\/[A-Za-z0-9_.\-/]*\.(?:js|mjs|json|md|css|html|ts|tsx)\b/g;

// Cross-repo citations: paths that live in a SIBLING project, not here. Each
// entry must say which repo owns it, so an entry can never be a quiet way to
// silence a genuinely dead in-repo path.
const CROSS_REPO = new Map([
  // .wiki/gotchas/flat-inputschema-constraint.md cites the host's schema
  // validator as `code-conductor/src/plugins/manifest.js`; the regex above sees
  // it from `src/` onward. Owned by the code-conductor repo, not this one.
  ['src/plugins/manifest.js', 'code-conductor'],
  // The host's MCP bridge and text-payload builder (docs/protocol.md's raw-text
  // channel, .wiki/gotchas/result-envelope-vs-ok-shape.md) and its plan-file
  // store (.wiki/gotchas/plan-link-and-sync-gap.md), cited from `src/` onward.
  ['src/plugins/mcpBridge.ts', 'code-conductor'],
  ['src/mcp/content.ts', 'code-conductor'],
  ['src/planFile.ts', 'code-conductor'],
]);


// Liveness floor: the MINIMUM number of citations that must actually reach the
// existence check below. Without it this sweep has a silent do-nothing mode — a
// deadened CITATION_RE, or a skip that swallows every citation, makes `dangling`
// trivially empty and the test passes while checking nothing. `files.length`
// cannot catch that: it guards only the walker, and both deadening shapes leave
// the walker intact.
//
// Counted AT THE CHECK, not at extraction. That placement is load-bearing: a
// counter incremented where the regex matches still dies to a deadened regex but
// SURVIVES a forced `continue`, because the CROSS_REPO skip runs after
// extraction. Here, every deadening shape yields exactly 0.
//
// The floor sits far under the real count of checked citations. Sized for
// ordinary doc churn, not as a tripwire on the real count: losing the
// heaviest-citing files at once must still stay green, while any do-nothing
// mutation reads 0. A floor near the real count would fail every time a doc
// legitimately shrinks; a floor of 0 is the defect this constant exists to close.
const MIN_CITATIONS_CHECKED = 40;

test('every in-repo file path cited in the docs/wiki/conventions prose exists', () => {
  const files = proseFiles();
  assert.ok(files.length > 10, `expected to scan a real doc set, scanned ${files.length}`);

  const dangling = [];
  let checked = 0;
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const cite of text.match(CITATION_RE) ?? []) {
      if (CROSS_REPO.has(cite)) continue;
      checked += 1;
      if (!fs.existsSync(path.join(ROOT, cite))) dangling.push(`${rel} -> ${cite}`);
    }
  }
  assert.ok(
    checked >= MIN_CITATIONS_CHECKED,
    `the sweep checked only ${checked} citations (floor ${MIN_CITATIONS_CHECKED}) — `
    + 'it is not reaching the corpus, so its empty result proves nothing',
  );
  assert.deepEqual(dangling, []);
});

// Guards the allowlist itself: an entry that starts resolving in-repo is no
// longer a cross-repo citation and must be dropped, or it would mask a real
// dangling path at that same name forever after.
test('no cross-repo citation allowlist entry resolves inside this repo', () => {
  for (const [cite, repo] of CROSS_REPO) {
    assert.equal(
      fs.existsSync(path.join(ROOT, cite)), false,
      `${cite} is allowlisted as owned by ${repo} but now exists here — drop the entry`,
    );
  }
});

// frontend/dist is build output (gitignored): it is absent from a fresh checkout,
// a mutation copy, and any tree before `npm install`, so a citation into it would
// make the sweep above fail exactly there. Docs name the built files in prose
// ("the built `index.html` in `frontend/dist`") instead. Checked here on its own,
// so it holds whether or not the build happens to exist.
test('no prose cites a file inside the gitignored frontend/dist build', () => {
  const intoDist = proseFiles().flatMap((rel) =>
    (fs.readFileSync(path.join(ROOT, rel), 'utf8').match(CITATION_RE) ?? [])
      .filter((cite) => cite.startsWith('frontend/dist/'))
      .map((cite) => `${rel} -> ${cite}`));
  assert.deepEqual(intoDist, []);
});
