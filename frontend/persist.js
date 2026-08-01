// Project-selection persistence for the web GUI. Kept as a pure module (no
// document at top level) so the node:test suite can import it directly — the
// GUI itself is zero-build vanilla ESM, but app.js touches the DOM on import.
// localStorage is namespaced so other apps on the same origin can't collide.

export const SELECTED_PROJECT_KEY = 'code-kanban:selected-project';

export function readSelectedProject(storage) {
  try {
    const s = storage ?? globalThis.localStorage;
    const v = s.getItem(SELECTED_PROJECT_KEY);
    return v ? v : null; // '' → null, so a stored empty string can't wedge the selector
  } catch {
    return null; // storage unavailable (privacy mode / sandbox) — degrade to default
  }
}

export function writeSelectedProject(name, storage) {
  try {
    const s = storage ?? globalThis.localStorage;
    if (name) s.setItem(SELECTED_PROJECT_KEY, name);
    else s.removeItem(SELECTED_PROJECT_KEY);
  } catch (e) {
    console.warn('persist: could not save project selection', e);
  }
}

export function resolveInitialProject(projects, saved) {
  return saved && projects.includes(saved) ? saved : (projects[0] ?? null);
}
