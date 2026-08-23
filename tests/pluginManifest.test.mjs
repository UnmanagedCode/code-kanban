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

// The advertised surface must match the implemented one: file_task accepts a
// `plan` param, optional, and the description has to state the absolute-path
// (ingest) form — that is the form a caller cannot guess from the grammar.
test('file_task advertises an optional string `plan` param covering the absolute form', () => {
  const fileTask = manifest.mcp.tools.find((t) => t.name === 'file_task');
  const prop = fileTask.inputSchema.properties.plan;
  assert.ok(prop, 'file_task advertises a plan param');
  assert.equal(prop.type, 'string');
  assert.equal(fileTask.inputSchema.required.includes('plan'), false, 'plan must not be required');
  assert.match(prop.description, /absolute/i);
  assert.match(prop.description, /board:/);
});

// The advertised priority enum is the ONE place the level catalog is duplicated
// outside src/priority.js (the manifest is static JSON the host reads before any
// code runs). Pin it to the code so the two can never drift.
// The advertised update_task surface must not drift from the implemented op
// shapes (2026-0020) — mirrors the file_task.plan description test above.
test('update_task advertises the acceptance op shapes', () => {
  const updateTask = manifest.mcp.tools.find((t) => t.name === 'update_task');
  const desc = updateTask.description;
  assert.match(desc, /ops/);
  assert.match(desc, /replace/);
  assert.match(desc, /null/);
  for (const op of ['add', 'remove', 'rename', 'done']) {
    assert.match(desc, new RegExp(op), `description mentions op "${op}"`);
  }
  const fieldsProp = updateTask.inputSchema.properties.fields;
  assert.match(fieldsProp.description, /acceptance/);
  // The flat-schema constraint still holds: fields stays an opaque object with
  // no nested `properties`, even though its acceptance value is itself nested.
  assert.equal('properties' in fieldsProp, false);
});

// 2026-0023: the advertised list_tasks/list_epics surface can't drift from the
// implemented default (done hidden unless includeDone/state:'done') — same
// discipline as the file_task.plan / update_task.acceptance manifest tests.
test('list_tasks advertises includeDone (boolean, default false) and describes the hidden-done default', () => {
  const listTasks = manifest.mcp.tools.find((t) => t.name === 'list_tasks');
  const prop = listTasks.inputSchema.properties.includeDone;
  assert.ok(prop, 'list_tasks advertises an includeDone param');
  assert.equal(prop.type, 'boolean');
  assert.equal(prop.default, false);
  assert.equal(listTasks.inputSchema.required.includes('includeDone'), false);
  assert.match(listTasks.description, /state:'done'/);
  assert.match(listTasks.description, /includeDone/);
  assert.match(listTasks.description, /PLAIN.TEXT/i);
});

test('list_epics advertises the plain-text listing in its description', () => {
  const listEpics = manifest.mcp.tools.find((t) => t.name === 'list_epics');
  assert.match(listEpics.description, /PLAIN.TEXT/i);
});

test('file_task advertises the priority enum from src/priority.js, with NO default', () => {
  const fileTask = manifest.mcp.tools.find((t) => t.name === 'file_task');
  const prop = fileTask.inputSchema.properties.priority;
  assert.ok(prop, 'file_task advertises a priority param');
  assert.deepEqual(prop.enum, PRIORITIES);
  assert.equal(prop.type, 'string');
  // The absence of `default` is the invariant: a default here would tell every
  // caller's schema layer to fill a level in, which is precisely the fabrication
  // this field must not do. Omitting priority leaves the card unjudged.
  assert.equal('default' in prop, false, 'file_task.priority must advertise no default');
  assert.equal(fileTask.inputSchema.required.includes('priority'), false);
  // ...and the prose must not promise one either.
  assert.match(prop.description, /unset/i);
  assert.equal(/default(s|ing)? to|omit(ting)? .{0,20}(for|means) MEDIUM/i.test(prop.description), false, prop.description);
});

// 2026-0025: the epic-level plan link and logbook. The tool schemas are the
// conductor's ONLY channel for these forms, so pin the advertised surface
// against the implemented one — same discipline as the file_task.plan test.
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
  assert.match(manifest.mcp.tools.find((t) => t.name === 'create_epic').inputSchema.properties.goal.description, /omit/i);
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

test('log_progress and read_progress advertise an `epic` param; read_progress no longer requires id', () => {
  const logProgress = manifest.mcp.tools.find((t) => t.name === 'log_progress');
  const readProgress = manifest.mcp.tools.find((t) => t.name === 'read_progress');
  for (const tool of [logProgress, readProgress]) {
    const prop = tool.inputSchema.properties.epic;
    assert.ok(prop, `${tool.name} advertises an epic param`);
    assert.equal(prop.type, 'string');
    assert.match(prop.description, /Mutually exclusive with `id`/);
  }
  assert.match(logProgress.inputSchema.properties.epic.description, /[Cc]onductor-only/);
  assert.match(logProgress.inputSchema.properties.epic.description, /[Nn]o lane gate/);
  assert.match(logProgress.inputSchema.properties.project.description, /epic/);
  // A cross-project epic read supplies NEITHER project nor id, so the old
  // required pair would make the advertised surface refuse a legal call.
  assert.equal(readProgress.inputSchema.required, undefined);
  assert.deepEqual(logProgress.inputSchema.required, ['entry']);
});
