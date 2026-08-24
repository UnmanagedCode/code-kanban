import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIORITIES } from '../src/priority.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'conductor.plugin.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Mirrors code-conductor/src/plugins/manifest.js: a tool inputSchema property
// may only use these keys, and may not nest another object schema.
const ALLOWED_PROP_KEYS = new Set([
  'type', 'description', 'enum', 'minLength', 'maxLength',
  'pattern', 'minimum', 'maximum', 'items', 'default',
]);
const FORBIDDEN = ['$ref', 'oneOf', 'anyOf', 'allOf', 'not'];

test('manifest identity + version matches package.json', () => {
  assert.equal(manifest.id, 'code-kanban');
  assert.equal(manifest.pluginApi, 1);
  assert.equal(manifest.version, pkg.version);
});

test('mcp block shape: endpoint + non-empty tools', () => {
  assert.ok(manifest.mcp.endpoint.startsWith('/'));
  assert.ok(Array.isArray(manifest.mcp.tools) && manifest.mcp.tools.length > 0);
  assert.ok(manifest.backend?.start);
});

// Mirrors code-conductor/src/plugins/manifest.js validateFrontend: path must
// start with '/', navLabel must be a non-empty string.
test('frontend block shape: path + navLabel', () => {
  const f = manifest.frontend;
  assert.ok(f && typeof f === 'object', 'frontend block present');
  assert.ok(typeof f.path === 'string' && f.path.startsWith('/'), 'frontend.path starts with /');
  assert.ok(typeof f.navLabel === 'string' && f.navLabel.trim() !== '', 'frontend.navLabel non-empty');
});

test('every tool inputSchema obeys the flat-schema subset', () => {
  for (const tool of manifest.mcp.tools) {
    assert.ok(tool.name && tool.description && tool.inputSchema, `tool ${tool.name} well-formed`);
    const schema = tool.inputSchema;
    assert.equal(schema.type, 'object', `${tool.name} root is object`);
    for (const bad of FORBIDDEN) {
      assert.equal(JSON.stringify(schema).includes(`"${bad}"`), false, `${tool.name} avoids ${bad}`);
    }
    for (const [prop, def] of Object.entries(schema.properties ?? {})) {
      for (const key of Object.keys(def)) {
        assert.ok(ALLOWED_PROP_KEYS.has(key), `${tool.name}.${prop} key "${key}" is allowed`);
      }
      // No nested object schema (the flat-schema constraint) — `properties`
      // must never appear inside a property definition.
      assert.equal('properties' in def, false, `${tool.name}.${prop} has no nested properties`);
    }
  }
});

// The advertised surface must match the implemented one: file_card accepts a
// `plan` param, optional, and the description has to state the absolute-path
// (ingest) form — that is the form a caller cannot guess from the grammar.
test('file_card advertises an optional string `plan` param covering the absolute form', () => {
  const fileCard = manifest.mcp.tools.find((t) => t.name === 'file_card');
  const prop = fileCard.inputSchema.properties.plan;
  assert.ok(prop, 'file_card advertises a plan param');
  assert.equal(prop.type, 'string');
  assert.equal(fileCard.inputSchema.required.includes('plan'), false, 'plan must not be required');
  assert.match(prop.description, /absolute/i);
  assert.match(prop.description, /board:/);
});

// The advertised priority enum is the ONE place the level catalog is duplicated
// outside src/priority.js (the manifest is static JSON the host reads before any
// code runs). Pin it to the code so the two can never drift.
// The advertised update_card surface must not drift from the implemented op
// shapes (2026-0020) — mirrors the file_card.plan description test above.
test('update_card advertises the acceptance op shapes', () => {
  const updateCard = manifest.mcp.tools.find((t) => t.name === 'update_card');
  const desc = updateCard.description;
  assert.match(desc, /ops/);
  assert.match(desc, /replace/);
  assert.match(desc, /null/);
  for (const op of ['add', 'remove', 'rename', 'done']) {
    assert.match(desc, new RegExp(op), `description mentions op "${op}"`);
  }
  const fieldsProp = updateCard.inputSchema.properties.fields;
  assert.match(fieldsProp.description, /acceptance/);
  // The flat-schema constraint still holds: fields stays an opaque object with
  // no nested `properties`, even though its acceptance value is itself nested.
  assert.equal('properties' in fieldsProp, false);
});

// 2026-0023: the advertised list_cards/list_epics surface can't drift from the
// implemented default (done hidden unless includeDone/state:'done') — same
// discipline as the file_card.plan / update_card.acceptance manifest tests.
test('list_cards advertises includeDone (boolean, default false) and describes the hidden-done default', () => {
  const listCards = manifest.mcp.tools.find((t) => t.name === 'list_cards');
  const prop = listCards.inputSchema.properties.includeDone;
  assert.ok(prop, 'list_cards advertises an includeDone param');
  assert.equal(prop.type, 'boolean');
  assert.equal(prop.default, false);
  assert.equal(listCards.inputSchema.required.includes('includeDone'), false);
  assert.match(listCards.description, /state:'done'/);
  assert.match(listCards.description, /includeDone/);
  // The surprising default itself — a caller who does not know it reads an
  // empty result as an empty lane. The plain-text rendering is NOT asserted
  // here: 2026-0027 cut that narration (the reader is holding the text), and
  // the channel is pinned where it is implemented, in tests/mcp.test.mjs.
  assert.match(listCards.description, /HIDES `done` BY DEFAULT/);
});

test('file_card advertises the priority enum from src/priority.js, with NO default', () => {
  const fileCard = manifest.mcp.tools.find((t) => t.name === 'file_card');
  const prop = fileCard.inputSchema.properties.priority;
  assert.ok(prop, 'file_card advertises a priority param');
  assert.deepEqual(prop.enum, PRIORITIES);
  assert.equal(prop.type, 'string');
  // The absence of `default` is the invariant: a default here would tell every
  // caller's schema layer to fill a level in, which is precisely the fabrication
  // this field must not do. Omitting priority leaves the card unjudged.
  assert.equal('default' in prop, false, 'file_card.priority must advertise no default');
  assert.equal(fileCard.inputSchema.required.includes('priority'), false);
  // ...and the prose must not promise one either.
  assert.match(prop.description, /unset/i);
  assert.equal(/default(s|ing)? to|omit(ting)? .{0,20}(for|means) MEDIUM/i.test(prop.description), false, prop.description);
});

// 2026-0025: the epic-level plan link and logbook. The tool schemas are the
// conductor's ONLY channel for these forms, so pin the advertised surface
// against the implemented one — same discipline as the file_card.plan test.
test('create_epic advertises an optional string `plan` covering the absolute form and the epic- destination', () => {
  const createEpic = manifest.mcp.tools.find((t) => t.name === 'create_epic');
  const prop = createEpic.inputSchema.properties.plan;
  assert.ok(prop, 'create_epic advertises a plan param');
  assert.equal(prop.type, 'string');
  assert.equal(createEpic.inputSchema.required.includes('plan'), false, 'plan must not be required');
  assert.match(prop.description, /absolute/i);
  assert.match(prop.description, /board:/);
  assert.match(prop.description, /epic-/); // the ingest destination a caller cannot guess
  assert.match(prop.description, /BOARD-LEVEL/); // the cross-project epic's base
  assert.match(prop.description, /repo:.*refused|refused.*repo:/s);
});

// D1 (preserve-on-omit) is a semantic change to an existing tool: a caller that
// does not know it will keep re-sending fields to avoid a clobber, or clobber by
// omission. Nothing else tells them.
test('create_epic\'s description states preserve-on-omit and how to clear', () => {
  const desc = manifest.mcp.tools.find((t) => t.name === 'create_epic').description;
  assert.match(desc, /preserv/i);
  assert.match(desc, /`goal: ''`|`plan: null`/);
  // No assertion on goal.description: restating the omit rule there is exactly
  // the duplication T7 now forbids.
});

test('read_epic advertises logTail + includePlan, and says plan_path is always returned', () => {
  const readEpic = manifest.mcp.tools.find((t) => t.name === 'read_epic');
  assert.equal(readEpic.inputSchema.properties.logTail.type, 'integer');
  const includePlan = readEpic.inputSchema.properties.includePlan;
  assert.equal(includePlan.type, 'boolean');
  assert.equal(includePlan.default, false);
  assert.equal(readEpic.inputSchema.required.includes('includePlan'), false);
  assert.match(readEpic.description, /plan_path always/);
  assert.match(readEpic.description, /logbook/);
});

// 2026-0027: the card|epic union was split into one tool per subject, so the
// exclusivity lives in disjoint `required[]` instead of prose. T1-T9 below each
// pin one invariant of that split; every description in the manifest is a
// system-prompt surface, so the prose assertions are as load-bearing as the
// shape ones.
const tool = (name) => manifest.mcp.tools.find((t) => t.name === name);
// Every description string in the manifest: each tool's own, plus every param's.
const allDescriptions = () => manifest.mcp.tools.flatMap((t) => [
  t.description,
  ...Object.values(t.inputSchema.properties ?? {}).map((p) => p.description),
].filter((d) => typeof d === 'string'));

// T-new-3 (card 2026-0028) — no manifest description says `task`. Every
// description here loads into a conductor session's SYSTEM PROMPT, so a stray
// old noun costs a reader disambiguation on every call, next to the harness's
// own TaskCreate/TaskGet/TaskList. Word-boundary-anchored so `multitask`-shaped
// words are not the thing being pinned; case-insensitive so `Task ids ...`
// counts.
test('no tool or param description says "task" — one noun on the public surface', () => {
  const offenders = allDescriptions().filter((d) => /\btask/i.test(d));
  assert.deepEqual(offenders, []);
});

// T1 — read_card_log is card-only, with BOTH addressing keys required. Pins the
// deletion of the epic arm AND the restoration of required[], which the union
// had dropped (making read_card_log({}) schema-legal).
test('read_card_log is card-only and requires project+id', () => {
  const readCardLog = tool('read_card_log');
  assert.deepEqual(readCardLog.inputSchema.required, ['project', 'id']);
  assert.equal('epic' in readCardLog.inputSchema.properties, false);
});

// T2 — the old union tool is gone and its replacement carries no epic surface.
test('log_progress is gone; log_card is card-only', () => {
  assert.equal(tool('log_progress'), undefined, 'log_progress must not be re-added');
  const logCard = tool('log_card');
  assert.ok(logCard, 'log_card exists');
  assert.equal('epic' in logCard.inputSchema.properties, false);
  // `project` stays optional: the worker path supplies neither project nor id.
  assert.deepEqual(logCard.inputSchema.required, ['entry']);
});

// T3 — log_epic's addressing must be byte-identical to read_epic's, because the
// whole point of the split is that "same subject => same addressing" is
// structural rather than promised in prose.
test('log_epic addresses an epic exactly as read_epic does', () => {
  const logEpic = tool('log_epic');
  const readEpic = tool('read_epic');
  for (const key of ['project', 'slug']) {
    const a = logEpic.inputSchema.properties[key];
    const b = readEpic.inputSchema.properties[key];
    assert.deepEqual({ type: a.type, minLength: a.minLength }, { type: b.type, minLength: b.minLength }, key);
  }
  assert.deepEqual(logEpic.inputSchema.required, ['slug', 'entry']);
});

// T4 — no mutual-exclusion PROSE anywhere. Banned manifest-wide deliberately:
// the flat-schema constraint means a `oneOf` can never back such a sentence
// (.wiki/gotchas/flat-inputschema-constraint.md), so an exclusivity stated in a
// description is an unenforced promise. If a future field pair really is
// exclusive, either split the tool (as log_card/log_epic did) or write the
// positive form — "Give exactly one of `x` or `y`." — which names the action a
// caller takes instead of the state they must avoid.
test('no description states a mutual exclusion in prose', () => {
  for (const desc of allDescriptions()) {
    assert.equal(/mutually exclusive/i.test(desc), false,
      `"mutually exclusive" is banned in tool prose (nothing enforces it) — split the tool, or write "Give exactly one of \`x\` or \`y\`.": ${desc}`);
  }
});

// T5 — the no-lane-gate refusal guard. A caller who does not know an epic has no
// state will not attempt the call at all (or will file a card first); nothing
// else volunteers it at the call site.
test('log_epic states the no-lane-gate rule and its audience', () => {
  const desc = tool('log_epic').description;
  assert.match(desc, /no lane gate/i);
  assert.match(desc, /Conductor/);
});

// T6 — the plan-link three-forms grammar appears IN FULL exactly once, in
// file_card.plan; the two other plan-taking surfaces cross-reference it.
test('the plan three-forms grammar is stated once, and cross-referenced twice', () => {
  const full = manifest.mcp.tools.flatMap((t) =>
    Object.entries(t.inputSchema.properties ?? {}).map(([k, p]) => [`${t.name}.${k}`, p.description ?? '']),
  ).filter(([, d]) => /ABSOLUTE path/.test(d) && /board:<rel>/.test(d));
  assert.deepEqual(full.map(([n]) => n), ['file_card.plan']);
  const xref = /same three input forms as `file_card`'s `plan`/i;
  assert.match(tool('update_card').description, xref);
  assert.match(tool('create_epic').inputSchema.properties.plan.description, xref);
});

// T7 — the upsert preserve-on-omit footgun is stated once, at tool level. It
// was stated three times inside create_epic before this card.
test('create_epic states preserve-on-omit exactly once', () => {
  const createEpic = tool('create_epic');
  const hits = [createEpic.description, ...Object.values(createEpic.inputSchema.properties).map((p) => p.description ?? '')]
    .filter((d) => /preserv/i.test(d));
  assert.equal(hits.length, 1);
  assert.equal(hits[0], createEpic.description);
  assert.match(createEpic.description, /`goal: ''`|`plan: null`/);
});

// T8 — the epic-resolution rule (own epic wins, member falls back to the cross
// epic) is stated once, on read_epic.project; log_epic points at it rather than
// restating it. One resolver in board.js backs both.
test('the epic-resolution rule is stated once and pointed at once', () => {
  const stating = allDescriptions().filter((d) =>
    /own epic wins|falling back to a cross-project|any member of a cross-project/.test(d));
  assert.deepEqual(stating, [tool('read_epic').inputSchema.properties.project.description]);
  assert.match(tool('log_epic').inputSchema.properties.project.description, /exactly as `read_epic`/);
});

// T9 — no description restates a field the RESULT already hands back. Each of
// these was a real sentence this card removed.
test('no description restates what the result already returns', () => {
  assert.equal(/includePlan also returns/.test(tool('read_epic').description), false);
  assert.equal(/includePlan also returns/.test(tool('read_card').description), false);
  assert.equal(/Returns the stored/.test(tool('create_epic').description), false);
  assert.equal(/server-assigned id/.test(tool('file_card').description), false);
});

// T10 — the prose budget. Every description in this file loads into the system
// prompt of every session using the plugin, so its size is a recurring
// per-session cost, not a one-off. 940 is the pre-20e4f31 figure BY THIS
// MEASURE (tool + param `description` words). The 1537 figure card 2026-0027
// originally carried was a whole-file `wc -w` including JSON punctuation — never
// a prose budget, and void. Adding a fact is allowed; adding it twice is not.
test('the manifest prose budget holds (<= 940 description words)', () => {
  const words = (s) => (s ?? '').trim().split(/\s+/).filter(Boolean).length;
  const total = manifest.mcp.tools.reduce((n, t) => n + words(t.description)
    + Object.values(t.inputSchema.properties ?? {}).reduce((a, p) => a + words(p.description), 0), 0);
  assert.ok(total <= 940, `manifest prose is ${total} words, budget is 940`);
});

// T11 — a changelog artifact is a phrase whose meaning depends on having seen an
// EARLIER version of the text ("…, as before"). A tool description has no
// readers who saw the previous one, so the phrase spends system-prompt words on
// nothing. State the fact instead of its history.
test('no description contains a changelog artifact', () => {
  for (const desc of allDescriptions()) {
    const hit = desc.match(/\b(as before|unchanged|previously|used to|no longer)\b/i);
    assert.equal(hit, null,
      `"${hit?.[0]}" is a changelog artifact — nobody reading this saw the earlier version. State the fact, not its history: ${desc}`);
  }
});
