import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, serializeBody, parse } from '../src/taskfile.js';

function sampleTask() {
  return {
    id: '2026-0042', uid: 'u-1', title: 'A card', project: 'demo', epic: 'reads',
    priority: 'HIGH', created: '2026-08-06T00:00:00.000Z', updated: '2026-08-06T01:00:00.000Z',
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
    'priority: HIGH',
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

// ---- priority: legacy tolerance ------------------------------------------
//
// parse must never throw and never lose a card, because a file may have been
// written by the pre-enum build or synced from a peer still running it. See
// .wiki/gotchas/priority-legacy-tolerance.md.

function cardText(priorityLine) {
  return [
    '---',
    'id: 2026-0001',
    'title: legacy',
    'project: demo',
    ...(priorityLine === null ? [] : [`priority: ${priorityLine}`]),
    'created: 2026-01-01T00:00:00.000Z',
    'depends_on: []',
    '---',
    '',
    '## Goal',
    'g',
    '',
    '## Acceptance',
    '',
    '## Logbook',
    '',
  ].join('\n');
}

test('parse maps each legacy integer frontmatter value to its level', () => {
  const cases = [['1', 'CRITICAL'], ['2', 'HIGH'], ['3', 'MEDIUM'], ['4', 'LOW'], ['5', 'LOW']];
  for (const [line, expected] of cases) {
    assert.equal(parse(cardText(line), { state: 'todo' }).priority, expected, `priority: ${line}`);
  }
});

// PARSE stage. Observes only what a card file becomes in memory.
test('parse sends 0, out-of-range, unknown and absent priority to unset', () => {
  for (const line of ['0', '6', '99', '-1', 'URGENT', 'p3', '', null]) {
    const t = parse(cardText(line), { state: 'todo' });
    assert.equal(t.priority, null, `priority: ${String(line)}`);
    // Never at the cost of the card: the rest of the frontmatter still parsed.
    assert.equal(t.id, '2026-0001', `priority: ${String(line)} lost the card`);
    assert.equal(t.goal, 'g');
  }
  // `0` is unset while `3` is a genuine MEDIUM — the legacy ladder's "never
  // judged" value must not be laundered into a judgement.
  assert.equal(parse(cardText('0'), { state: 'todo' }).priority, null);
  assert.equal(parse(cardText('3'), { state: 'todo' }).priority, 'MEDIUM');
});

// SERIALIZE stage, and deliberately NOT via parse: every input here is a raw
// object literal that never went through parse, so nothing has pre-coerced the
// value in memory. (Feeding parse's output in would pin parse-normalisation a
// second time and prove nothing about the serializer.)
test('serialize omits the priority key entirely when the card is unset', () => {
  const base = sampleTask();
  for (const value of [null, undefined, 0, '0', 'bogus', 6, '']) {
    const out = serialize({ ...base, priority: value });
    assert.equal(/^priority:/m.test(out), false, `${JSON.stringify(value)} must emit no priority line\n${out}`);
    // The card itself is intact — omitting the key is not dropping the card.
    assert.ok(out.includes('\nid: 2026-0042\n'), out);
    assert.ok(out.includes('\ndepends_on: [2026-0001, 2026-0002]\n'), out);
  }
});

test('serialize writes the level verbatim when the card is judged', () => {
  const base = sampleTask();
  for (const [value, expected] of [[1, 'CRITICAL'], ['low', 'LOW'], ['MEDIUM', 'MEDIUM'], ['HIGH', 'HIGH']]) {
    const out = serialize({ ...base, priority: value });
    assert.ok(out.includes(`\npriority: ${expected}\n`), `${JSON.stringify(value)} -> ${expected}\n${out}`);
  }
});

test('serialize(parse(legacy)) rewrites the level — the tolerant parse IS the migration', () => {
  // Both stages together, which is what actually lands on disk. `2` becomes a
  // level; `0` becomes an absent key rather than a fabricated one.
  const rewritten = serialize(parse(cardText('2'), { state: 'todo' }));
  assert.ok(rewritten.includes('\npriority: HIGH\n'), rewritten);
  assert.equal(rewritten.includes('priority: 2'), false, rewritten);

  const cleared = serialize(parse(cardText('0'), { state: 'todo' }));
  assert.equal(/^priority:/m.test(cleared), false, cleared);
});

test('parse(serialize(t)) round-trips every level AND unset', () => {
  const base = sampleTask();
  for (const level of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', null]) {
    const back = parse(serialize({ ...base, priority: level }), { state: 'todo' });
    assert.equal(back.priority, level, `${String(level)} did not round-trip`);
  }
});
