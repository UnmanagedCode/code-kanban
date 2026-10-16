// Project-selection persistence. Pure (no DOM at import, storage injectable) so
// node:test imports it directly. The key carries the plugin-id prefix: plugins and
// code-conductor share one origin's storage.

/** The minimal Storage surface these helpers use. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SELECTED_PROJECT_KEY = 'code-kanban:selected-project';

export function readSelectedProject(storage?: KeyValueStorage): string | null {
  try {
    const s = storage ?? globalThis.localStorage;
    return s.getItem(SELECTED_PROJECT_KEY);
  } catch {
    return null; // storage unavailable (privacy mode / sandbox): degrade to the default
  }
}

export function writeSelectedProject(name: string | null, storage?: KeyValueStorage): void {
  try {
    const s = storage ?? globalThis.localStorage;
    if (name) s.setItem(SELECTED_PROJECT_KEY, name);
    else s.removeItem(SELECTED_PROJECT_KEY);
  } catch (e) {
    console.warn('persist: could not save project selection', e);
  }
}

/** The saved project while it is still listed, else the first listed one, else null. */
export function resolveInitialProject(projects: readonly string[], saved: string | null): string | null {
  return saved && projects.includes(saved) ? saved : (projects[0] ?? null);
}
