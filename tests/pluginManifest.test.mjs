import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
