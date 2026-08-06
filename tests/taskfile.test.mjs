import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, serializeBody, parse } from '../src/taskfile.js';

function sampleTask() {
  return {
    id: '2026-0042', uid: 'u-1', title: 'A card', project: 'demo', epic: 'reads',
    priority: 3, created: '2026-08-06T00:00:00.000Z', updated: '2026-08-06T01:00:00.000Z',
    node: 'node-a', owner: 'w-1', commit: 'abc123', plan: 'board:p.md',
    depends_on: ['2026-0001', '2026-0002'],
    goal: 'Multi-line\n\ngoal prose.',
    acceptance: [{ text: 'first', done: true }, { text: 'second', done: false }],
    logbook: ['2026-08-06T00:00:00.000Z · abcd1234 · filed'],
  };
}

// serializeBody is the body half of the file format, exported so src/mcp.js can
// render a card as raw markdown. This pins the extraction: serialize is exactly
// the frontmatter block followed by serializeBody's output, byte for byte. If
// the two ever diverge, an MCP read would describe a shape the file never had.
test('serialize === frontmatter block + serializeBody, byte for byte', () => {
  const t = sampleTask();
  const full = serialize(t);
  const body = serializeBody(t);

  assert.ok(full.endsWith(body));
  const prefix = full.slice(0, full.length - body.length);
  assert.equal(prefix, [
    '---',
    'id: 2026-0042',
    'uid: u-1',
    'title: A card',
    'project: demo',
    'epic: reads',
    'priority: 3',
    'created: 2026-08-06T00:00:00.000Z',
    'updated: 2026-08-06T01:00:00.000Z',
    'node: node-a',
    'owner: w-1',
    'commit: abc123',
    'plan: board:p.md',
    'depends_on: [2026-0001, 2026-0002]',
    '---',
    '',
  ].join('\n'));
  // The body itself, so a change to either half fails here rather than silently
  // moving the boundary.
  assert.equal(body, [
    '## Goal',
    'Multi-line',
    '',
    'goal prose.',
    '',
    '## Acceptance',
    '- [x] first',
    '- [ ] second',
    '',
    '## Logbook',
    '- 2026-08-06T00:00:00.000Z · abcd1234 · filed',
    '',
  ].join('\n'));
});

test('serializeBody on an empty card still emits all three sections', () => {
  const body = serializeBody({ goal: '', acceptance: [], logbook: [] });
  assert.equal(body, '## Goal\n\n\n## Acceptance\n\n## Logbook\n');
  // Same as the frontmatter-stripped tail of serialize.
  const full = serialize({ id: 'x', title: 't', project: 'demo', created: 'c', depends_on: [] });
  assert.ok(full.endsWith(body));
});

test('parse(serialize(t)) round-trips every field', () => {
  const t = sampleTask();
  const back = parse(serialize(t), { state: 'in-progress' });
  for (const k of Object.keys(t)) assert.deepEqual(back[k], t[k], `field ${k}`);
  assert.equal(back.state, 'in-progress');
});
