@../CLAUDE.md

## Design guidelines
- YAGNI — build only what a current, concrete requirement needs; no speculative abstractions, config knobs, or extension points "for later." If code isn't exercised by a real caller or test, delete it rather than keep it "just in case."
- One responsibility per module — when a module takes on a second concern, extract it as a composed collaborator behind a stable interface; no god-modules.
- Single source of truth — shared catalogs, config, and constants live in one authoritative place and are read from there; never duplicate them (a startup fallback is fine — it's a fallback, not a second source).
- Keep wiring thin — entry/bootstrap code builds state and calls each feature's init once; feature logic lives in its own module, not the entry point.
- Share one implementation across surfaces — when the same logic backs multiple interfaces (e.g. an HTTP API and a CLI/MCP tool), write it once and import it from both; never reimplement per surface.
- Depend on stable interfaces, not internals — collaborators talk through narrow, documented surfaces so either side can change independently.
- Fail loudly, not silently — surface errors with context; reserve fallbacks for genuine, logged degradations.

## Testing guidelines
- Prefer automated tests over manual verification checklists — write runnable proof, not a script to follow by hand.
- Tests must be deterministic and fast: no long real sleeps, no live network, no wall-clock dependence. Use short timeouts and fake/injected clocks, and assert on the killed/cancelled outcome rather than waiting out a delay.
- Isolate state: each test sets up and tears down its own fixtures (fresh temp dirs, no shared globals) so tests pass in any order.
- For expensive/external systems (a real CLI or API), build a small fake emitting canned output and inject it via env var; keep one real-dependency smoke test gated behind an env flag (e.g. `RUN_REAL_X=1`).
- Use the language's built-in test runner unless the project already uses another framework; avoid adding dependencies.
- When presenting an implementation plan, include an "Integration tests" section listing the actual test files, what they cover, and the run command — not a "Manual verification" section.
- Run tests as the last implementation step and report pass/fail; don't ask the user to verify by hand.

## Documentation guidelines
Layer docs; on any behavior change, update the most specific file — not just the README.
- `docs/features.md` — user-facing features, UI, new tools.
- `docs/protocol.md` — interface contracts: endpoints, message types, protocol flags, wire formats.
- `docs/architecture.md` — internals: components, lifecycle, on-disk state, migrations, test patterns.
- `README.md` — overview, quick start, key defaults, known limitations; add a one-line note here only when a change adds a new top-level subsystem.
This overrides the workspace README-maintenance update rule here: README changes only for new top-level subsystems; new commands/flags/endpoints go to the matching `docs/*.md`.
The workspace "Be precise and compact" rule applies to all doc files, not just the README.

# Project wiki

This project keeps a `.wiki/` of durable codebase knowledge: gotchas, non-obvious decisions, glossary, architecture shape.

- Before planning: read `.wiki/index.md`, then the 1–3 pages it points to that are relevant to your task.
- When you learn something durable (a gotcha, a non-obvious decision or distinction, a subsystem's shape), add or update the relevant page and refresh `index.md` in the same reviewed diff — not a separate commit.
- One topic per page. Cite `path:line` instead of pasting code.
- If a page is marked `reviewed: true`, don't overwrite it — merge your update into it.
- Weight content toward gotchas, decisions, and glossary (things a reader can't quickly re-derive from the code), not architecture prose.

# Visually verify UX changes

Always test and visually verify UX changes before considering them done — don't rely on automated tests alone for UI, layout, or visual changes.

- If this project already has a local visual-verification harness — check `harness/playwright/` first, else wherever its dev/helper scripts live — use it to capture a screenshot and confirm the change renders correctly.
- If not, create one using the shared `code-playwright` utilities as a base — see its README, "Using from a sibling project" section, for how to import and wire it up.
- Drive the actual golden path (and any obviously-affected edge cases) through the harness, not just a single static screenshot, when the change affects interaction or state.
