# Gotcha: resolving the `.conduct` path

Board data lives at `<PROJECTS_ROOT>/.conduct/kanban/...`, in the **conductor's** tree — not in
this repo. Resolve it from the injected `PROJECTS_ROOT` env var (`src/paths.js:kanbanRoot`):

- **Never hardcode** the absolute path (`/workspaces/cc-projects/...`).
- **Never import** the host's `conductProjectPath()` — this plugin runs **out-of-process**; host
  modules are unreachable. The conductor injects the resolved `PROJECTS_ROOT` at spawn.
- The `.conduct` segment is a stable host constant (`CONDUCT_PROJECT_NAME`, no env override), so
  the literal string is safe to embed.
- Standalone/dev (no conductor): `PROJECTS_ROOT` falls back to the repo's parent dir
  (`paths.js:DEFAULT_PROJECTS_ROOT`).

Safety note: the host rewrites `.conduct/CONDUCT.md` and `.conduct/CLAUDE.md` on boot/settings
change but **never touches subdirectories**, so `.conduct/kanban/` is safe from the host.
