import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parsePlanLink, resolvePlanLink, classifyPlanInput, isContained } from '../src/planLink.js';
import { plansDir, projectRepoDir } from '../src/paths.js';

// Pure grammar/containment tests — no temp root, no fs. PROJECTS_ROOT is only
// read to compute the expected base dirs, so whatever the ambient value is,
// both sides of each assertion agree.
const P = 'demo';

test('planLink: a bare relative path normalizes to board: and resolves under plans/', () => {
  const r = resolvePlanLink(P, 'docs/plan.md');
  assert.equal(r.error, undefined);
  assert.equal(r.scheme, 'board');
  assert.equal(r.link, 'board:docs/plan.md');
  assert.equal(r.path, path.join(plansDir(P), 'docs/plan.md'));
});

test('planLink: an explicit board: link keeps its scheme', () => {
  const r = resolvePlanLink(P, 'board:2026-0009.md');
  assert.equal(r.link, 'board:2026-0009.md');
  assert.equal(r.path, path.join(plansDir(P), '2026-0009.md'));
});

test('planLink: a repo: link resolves under the project BASE checkout', () => {
  const r = resolvePlanLink(P, 'repo:docs/plans/x.md');
  assert.equal(r.scheme, 'repo');
  assert.equal(r.link, 'repo:docs/plans/x.md');
  assert.equal(r.path, path.join(projectRepoDir(P), 'docs/plans/x.md'));
});

test('planLink: a nested relative path is fine', () => {
  const r = resolvePlanLink(P, 'sub/dir/p.md');
  assert.equal(r.link, 'board:sub/dir/p.md');
  assert.equal(r.path, path.join(plansDir(P), 'sub', 'dir', 'p.md'));
});

test('planLink: surrounding whitespace is trimmed (so the value round-trips through frontmatter)', () => {
  assert.equal(resolvePlanLink(P, '  board:p.md \t').link, 'board:p.md');
});

test('planLink: internal spaces in a filename are preserved', () => {
  const r = resolvePlanLink(P, 'my plan.md');
  assert.equal(r.link, 'board:my plan.md');
  assert.equal(r.path, path.join(plansDir(P), 'my plan.md'));
});

test('planLink: an empty / whitespace-only link -> INVALID_STATE', () => {
  for (const v of ['', '   ', '\t', 'board:', 'repo:   ']) {
    const r = parsePlanLink(v);
    assert.equal(r.error?.code, 'INVALID_STATE', `"${v}" refused`);
    assert.match(r.error.reason, /empty/);
  }
});

test('planLink: a non-string link -> INVALID_STATE', () => {
  for (const v of [42, {}, [], undefined, true]) {
    assert.equal(parsePlanLink(v).error?.code, 'INVALID_STATE');
  }
});

test('planLink: an embedded newline/CR -> INVALID_STATE (frontmatter is one verbatim line)', () => {
  for (const v of ['a.md\nowner: mallory', 'a.md\rowner: mallory']) {
    const r = parsePlanLink(v);
    assert.equal(r.error?.code, 'INVALID_STATE');
    assert.match(r.error.reason, /newline/);
  }
});

test('planLink: an unknown scheme -> INVALID_STATE', () => {
  for (const v of ['file:x', 'http://example.com/p.md', 'C:\\x', 'c:/x']) {
    const r = parsePlanLink(v);
    assert.equal(r.error?.code, 'INVALID_STATE', `"${v}" refused`);
    assert.match(r.error.reason, /scheme/);
  }
});

// A BARE absolute path is no longer a pointer at all — it is an ingest source
// (classifyPlanInput below). After an EXPLICIT scheme it stays refused: the
// scheme makes it a pointer, and a pointer must be relative.
test('planLink: an absolute path AFTER AN EXPLICIT SCHEME -> INVALID_STATE', () => {
  for (const v of ['board:/abs/path.md', 'repo:/etc/passwd']) {
    const r = parsePlanLink(v);
    assert.equal(r.error?.code, 'INVALID_STATE', `"${v}" refused`);
    assert.match(r.error.reason, /relative/);
  }
  // ...and the scheme'd form is not diverted to ingest either.
  for (const v of ['board:/abs/path.md', 'repo:/etc/passwd']) {
    const c = classifyPlanInput(P, v);
    assert.equal(c.kind, undefined, `"${v}" is not classified as a pointer/ingest`);
    assert.equal(c.error?.code, 'INVALID_STATE');
    assert.match(c.error.reason, /relative/);
  }
});

test('classifyPlanInput: a BARE absolute path -> ingest, resolved lexically', () => {
  const c = classifyPlanInput(P, '/home/node/.claude/plans/x.md');
  assert.equal(c.kind, 'ingest');
  assert.equal(c.source, '/home/node/.claude/plans/x.md');
  assert.equal(c.error, undefined);
  // path.resolve normalises lexically (no fs, no symlink resolution).
  assert.equal(classifyPlanInput(P, '/a/../a/p.md').source, '/a/p.md');
  // Trimmed like every other value, so it round-trips through frontmatter.
  assert.deepEqual(classifyPlanInput(P, '  /a/p.md \t'), { kind: 'ingest', source: '/a/p.md' });
});

test('classifyPlanInput: a Windows drive letter stays an unknown-scheme refusal, never an ingest', () => {
  // SCHEME_RE is tested BEFORE path.isAbsolute — the ordering is what keeps
  // `C:\x` a loud refusal instead of a copy of some bizarre path.
  for (const v of ['C:\\x', 'c:/x', 'file:x', 'http://example.com/p.md']) {
    const c = classifyPlanInput(P, v);
    assert.equal(c.kind, undefined, `"${v}" is not an ingest`);
    assert.equal(c.error?.code, 'INVALID_STATE');
    assert.match(c.error.reason, /scheme/);
  }
});

test('classifyPlanInput: relative / bare / scheme\'d values are pointers, unchanged', () => {
  for (const v of ['p.md', 'board:p.md', 'sub/dir/p.md']) {
    const c = classifyPlanInput(P, v);
    assert.equal(c.kind, 'pointer');
    assert.equal(c.scheme, 'board');
    assert.equal(c.link, v === 'sub/dir/p.md' ? 'board:sub/dir/p.md' : 'board:p.md');
    assert.equal(c.path, path.join(plansDir(P), v.replace(/^board:/, '')));
  }
  const r = classifyPlanInput(P, 'repo:docs/x.md');
  assert.equal(r.kind, 'pointer');
  assert.equal(r.link, 'repo:docs/x.md');
  assert.equal(r.path, path.join(projectRepoDir(P), 'docs/x.md'));
});

test('classifyPlanInput: empty / non-string / newline values refuse, never ingest', () => {
  for (const v of ['', '   ', 'board:', 42, {}, undefined, null]) {
    const c = classifyPlanInput(P, v);
    assert.equal(c.kind, undefined, `${JSON.stringify(v)} is not an ingest`);
    assert.equal(c.error?.code, 'INVALID_STATE');
  }
  // An absolute path with an embedded newline must NOT become an ingest source:
  // the value lands verbatim on a one-line frontmatter key.
  const c = classifyPlanInput(P, '/abs/p.md\nowner: mallory');
  assert.equal(c.kind, undefined);
  assert.match(c.error.reason, /newline/);
});

test('planLink: ../ traversal out of the base -> INVALID_STATE', () => {
  for (const v of ['../escape.md', 'a/../../b.md', 'board:../../../etc/passwd', 'repo:../other-project/x.md']) {
    const r = resolvePlanLink(P, v);
    assert.equal(r.error?.code, 'INVALID_STATE', `"${v}" refused`);
    assert.match(r.error.reason, /inside its base/);
  }
});

test('planLink: a link resolving to the base dir itself -> INVALID_STATE', () => {
  assert.equal(resolvePlanLink(P, 'a/..').error?.code, 'INVALID_STATE');
});

test('planLink: isContained rejects the base itself, escapes and absolutes', () => {
  const base = '/tmp/base';
  assert.equal(isContained(base, '/tmp/base/x.md'), true);
  assert.equal(isContained(base, '/tmp/base/a/b.md'), true);
  assert.equal(isContained(base, '/tmp/base'), false);
  assert.equal(isContained(base, '/tmp/other/x.md'), false);
  assert.equal(isContained(base, '/etc/passwd'), false);
});
