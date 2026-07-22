// Minimal per-key async mutex: a promise chain per key serializes the callbacks
// so mutations sharing a key never interleave. This is the board's single write
// path — MCP-tool calls and (later) same-process GUI requests both funnel
// through withLock(project, ...), making the file store race-free without any
// git or file-level locking. Keys accumulate for the process lifetime, which is
// fine for the small, bounded set of project names a session touches.
const tails = new Map();

export function withLock(key, fn) {
  const prev = tails.get(key) ?? Promise.resolve();
  // Run fn after the previous holder settles, regardless of its outcome.
  const result = prev.then(fn, fn);
  // Keep the chain alive but swallow errors in the stored tail so one failed
  // critical section never rejects the next caller's wait.
  tails.set(key, result.then(() => {}, () => {}));
  return result;
}
