// Resolves a worker session (a task's `owner` while in-progress) to its live
// working directory, via the conductor's /api/instances — the same
// CONDUCTOR_URL HTTP channel projects.js uses for /api/projects. An instance's
// `cwd` IS the worktree path when the session runs in a worktree (the common
// case for a landed worker), or the base project checkout otherwise — either
// way it's the directory whose HEAD is the actual landing commit, unlike the
// base project's own checkout (which won't contain a worktree'd worker's
// commits until a merge).
let fetchInstancesImpl = defaultFetchInstances;

// Seam for tests: swap the live-instance fetcher so resolution never touches
// the network. Pass null to restore the default.
export function _setInstanceFetcher(fn) {
  fetchInstancesImpl = fn ?? defaultFetchInstances;
}

async function defaultFetchInstances() {
  const base = process.env.CONDUCTOR_URL;
  if (!base) return [];
  const res = await fetch(`${base}/api/instances`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Returns the owner session's live working directory, or null if it can't be
// resolved (no CONDUCTOR_URL, no session id, or the session isn't in the
// conductor's in-memory instance registry — e.g. already torn down). The
// caller is expected to degrade gracefully on null, not refuse.
export async function ownerCwd(sessionId) {
  if (!sessionId) return null;
  let list;
  try { list = await fetchInstancesImpl(); } catch { return null; }
  const inst = list.find((i) => i?.sessionId === sessionId);
  return inst?.cwd ?? null;
}
