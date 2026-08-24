import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-0028 — every in-repo file path cited by the prose layers must resolve to
// a file that exists.
//
// SCOPE, and the limit is the point: this closes PATH EXISTENCE only. It does
// NOT check that a `path:line` citation points at the line it claims — that
// needs the cited symbol, which no generic test can know. Card 2026-0028 fixed
// four such stale line numbers by hand (SCALAR_KEYS, file_card's acceptance
// mapping, .detail-head, and a wiki plan-link cite) and a follow-up card carries
// the rest. So a green run here means "no dangling paths", never "citations are
// accurate" — do not read it as the stronger claim.
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

test('every in-repo file path cited in the docs/wiki/conventions prose exists', () => {
  const files = PROSE_ROOTS.flatMap(walk);
  assert.ok(files.length > 10, `expected to scan a real doc set, scanned ${files.length}`);

  const dangling = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const cite of text.match(CITATION_RE) ?? []) {
      if (CROSS_REPO.has(cite)) continue;
      if (!fs.existsSync(path.join(ROOT, cite))) dangling.push(`${rel} -> ${cite}`);
    }
  }
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
