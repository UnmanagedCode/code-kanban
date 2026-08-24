# Gotcha: manifest tool schemas must be flat

The host (`code-conductor/src/plugins/manifest.js`, `checkSchemaSubset`) validates each tool's
`inputSchema` and **rejects** at load time: `$ref`, `oneOf`, `anyOf`, `allOf`, `not`, and any
**nested `properties`** (an object-typed property may not declare its inner shape). Allowed
per-property keys: `type, description, enum, minLength, maxLength, pattern, minimum, maximum,
items, default`.

Consequences for our tools:
- `update_task.fields` is an object with inner keys — **not expressible**. It is advertised as an
  opaque `{type:"object"}` and its keys validated at runtime in `board.updateTask`. (Same trick
  code-hub uses to omit `register_app.routes`.) `fields.acceptance` (2026-0020) goes one level
  deeper still — its value is itself a nested op object (`{ops:[…]}` / `{replace:[…]}` / `null`) —
  but it's still just a value inside the same opaque `fields`, so nothing new is needed to hide it;
  it's runtime-validated by `resolveAcceptanceForSet` in `src/board.js`.
- Array params (`acceptance`, `depends_on`) are fine: `{type:"array", items:{type:"string"}}`.
- `enum` is allowed and used by `move_task.to`/`list_tasks.state` (states), `file_task.category`
  and `file_task.priority`; `default` is allowed too (`read_task.includePlan` pairs it with
  `default: false`). `file_task.priority` deliberately carries `enum` and **no** `default` — a
  default there would have the host's schema layer fill in a level nobody chose (see
  [priority-legacy-tolerance.md](priority-legacy-tolerance.md)).
- `integer`+`minimum` is allowed — `read_task.logTail`, `read_progress.limit`.

The `oneOf` ban is also why a card|epic union tool does not exist — see
[[card-epic-tool-split]].

`tests/pluginManifest.test.mjs` guards this — it asserts the subset and that
`manifest.version === package.json version` (the host also checks the latter).
