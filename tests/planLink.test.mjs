import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parsePlanLink, resolvePlanLink, isContained } from '../src/planLink.js';
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

test('planLink: an absolute path -> INVALID_STATE', () => {
  for (const v of ['/abs/path.md', 'board:/abs/path.md', 'repo:/etc/passwd']) {
    const r = parsePlanLink(v);
    assert.equal(r.error?.code, 'INVALID_STATE', `"${v}" refused`);
    assert.match(r.error.reason, /relative/);
  }
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
