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
