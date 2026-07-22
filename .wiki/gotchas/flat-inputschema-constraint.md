# Gotcha: manifest tool schemas must be flat

The host (`code-conductor/src/plugins/manifest.js`, `checkSchemaSubset`) validates each tool's
`inputSchema` and **rejects** at load time: `$ref`, `oneOf`, `anyOf`, `allOf`, `not`, and any
**nested `properties`** (an object-typed property may not declare its inner shape). Allowed
per-property keys: `type, description, enum, minLength, maxLength, pattern, minimum, maximum,
items, default`.

Consequences for our tools:
- `update_task.fields` is an object with inner keys — **not expressible**. It is advertised as an
  opaque `{type:"object"}` and its keys validated at runtime in `board.updateTask`. (Same trick
  code-hub uses to omit `register_app.routes`.)
- Array params (`acceptance`, `depends_on`) are fine: `{type:"array", items:{type:"string"}}`.
- `enum` (states) and `integer`+`minimum` (`priority`, `logTail`, `limit`) are allowed.

`tests/pluginManifest.test.mjs` guards this — it asserts the subset and that
`manifest.version === package.json version` (the host also checks the latter).
