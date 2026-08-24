import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Prose layers that cite code. `harness/` is included deliberately: its mutation
// README quotes module paths and test titles, and a gate that skips a whole
// directory is not a gate.
const PROSE_ROOTS = ['docs', '.wiki', 'conventions', 'harness', 'README.md', 'CONVENTIONS.md'];

// Directory prefixes that name THIS repo's tree. A citation must start with one
// to be checked at all, which is what keeps bare prose words out.
const CITATION_RE = /\b(?:src|tests|frontend|harness|docs|conventions)\/[A-Za-z0-9_.\-/]*\.(?:js|mjs|json|md|css|html)\b/g;

// Cross-repo citations: paths that live in a SIBLING project, not here. Each
// entry must say which repo owns it, so an entry can never be a quiet way to
// silence a genuinely dead in-repo path.
const CROSS_REPO = new Map([
  // .wiki/gotchas/flat-inputschema-constraint.md cites the host's schema
  // validator as `code-conductor/src/plugins/manifest.js`; the regex above sees
  // it from `src/` onward. Owned by the code-conductor repo, not this one.
  ['src/plugins/manifest.js', 'code-conductor'],
]);

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return rel.endsWith('.md') ? [rel] : [];
  return fs.readdirSync(abs).flatMap((n) => walk(path.join(rel, n)));
}

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
// The floor is 40 against a measured 125 (126 extracted, 1 allowlisted). Sized
// for ordinary doc churn, not as a tripwire on the real count: the five
// heaviest-citing files together hold 69 citations, so losing all five at once
// still leaves 56 and stays green, while any do-nothing mutation reads 0. A
// floor near 125 would fail every time a doc legitimately shrinks; a floor of 0
// is the defect this constant exists to close.
const MIN_CITATIONS_CHECKED = 40;

test('every in-repo file path cited in the docs/wiki/conventions prose exists', () => {
  const files = PROSE_ROOTS.flatMap(walk);
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
