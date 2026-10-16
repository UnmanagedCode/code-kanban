// Board view logic: what the components render, as data. Pure (no DOM, no React)
// so node:test imports it directly. The catalogs (states, transitions, priority
// levels) come from GET api/board/meta, never a copy; the server's order and its
// `completed` flag are kept, never recomputed.

export interface Meta {
  states: string[];
  /** ALLOWED_TRANSITIONS serialised as "from>to". */
  transitions: string[];
  /** Rank order, highest first. */
  priorities: string[];
}

export type Rollup = Record<string, number>;

export interface Card {
  id: string;
  title: string;
  state: string;
  project?: string;
  epic?: string | null;
  priority?: string | null;
  owner?: string | null;
  commit?: string | null;
  plan?: string | null;
  goal?: string;
  acceptance?: { text: string; done: boolean }[];
  logbook?: string[];
  depends_on?: string[];
}

export interface Epic {
  slug: string;
  title: string;
  goal?: string;
  /** Present exactly when the epic is cross-project. */
  projects?: string[];
  plan?: string | null;
  rollup?: Rollup;
  completed?: boolean;
}

/** A refusal envelope's reason (`{ok:false}` at HTTP 200), or null for any other body. */
export function refusalReason(data: unknown): string | null {
  const d = data as { ok?: unknown; reason?: unknown; code?: unknown } | null;
  if (d && d.ok === false) return (d.reason as string) || (d.code as string) || 'refused';
  return null;
}

/** The legal move targets from `from`, in the server's order. */
export function transitionsFrom(meta: Meta, from: string): string[] {
  return meta.transitions
    .filter((t) => t.startsWith(from + '>'))
    .map((t) => t.split('>')[1]);
}

// EVERY judged level gets a badge, so a bare card means exactly one thing:
// nobody has judged it yet. Badging only some levels would make bare ambiguous
// between a judgement and the absence of one.
export function badgedPriority(p: unknown): p is string {
  return typeof p === 'string' && p !== '';
}

/** Badge variant per priority level: graded so the four read as a ladder. */
export const PRIORITY_BADGE: Record<string, 'destructive' | 'warning' | 'secondary' | 'outline'> = {
  CRITICAL: 'destructive',
  HIGH: 'warning',
  MEDIUM: 'secondary',
  LOW: 'outline',
};

/** One lane's cards in server order, optionally only those with a plan link. */
export function laneCards(cards: readonly Card[], state: string, planOnly: boolean): Card[] {
  return cards.filter((c) => c.state === state && (!planOnly || !!c.plan));
}

/** Lane header text: `in-progress` → `In progress`. */
export function laneLabel(state: string): string {
  const s = state.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Lane top-border hue per state, on host tokens. Each names a column, not a status. */
export const LANE_ACCENT: Record<string, string> = {
  triage: 'border-t-plan',
  backlog: 'border-t-info',
  todo: 'border-t-primary',
  'in-progress': 'border-t-warning',
  done: 'border-t-success',
};

/** Active epics then completed ones, each in server order, by the server's flag. */
export function splitEpics(epics: readonly Epic[]): { active: Epic[]; completed: Epic[] } {
  return {
    active: epics.filter((e) => !e.completed),
    completed: epics.filter((e) => e.completed),
  };
}

// Two-character rollup labels: a state's first letter collides (triage and todo
// both start with "t"). Keys track STATES in src/paths.js; an unknown state shows
// its full name.
export const ROLLUP_LABEL: Record<string, string> = { triage: 'tr', backlog: 'bk', todo: 'td', 'in-progress': 'ip', done: 'dn' };

export interface RollupPill {
  state: string;
  label: string;
  count: number;
  zero: boolean;
}

/** One pill per state, in `meta.states` order; a missing count is 0. */
export function rollupPills(states: readonly string[], rollup: Rollup | undefined): RollupPill[] {
  return states.map((s) => {
    const count = rollup?.[s] ?? 0;
    return { state: s, label: ROLLUP_LABEL[s] ?? s, count, zero: count === 0 };
  });
}

/**
 * A logbook line `<ISO> · <sid8> · <entry>` split for display. `sid` is '' when the
 * line has fewer than three parts, and then `rest` is the whole line.
 */
export function parseLogLine(line: string): { time: string; sid: string; rest: string } {
  const parts = line.split(' · ');
  if (parts.length < 3) return { time: '', sid: '', rest: line };
  return { time: parts[0], sid: parts[1], rest: parts.slice(2).join(' · ') };
}

/**
 * An epic <select>'s options: none, the active slugs, then the completed slugs (a
 * "Completed" optgroup). `value` keeps the card's current epic selected even when it
 * is completed; an epic that is not listed selects none.
 */
export function epicOptions(epics: readonly Epic[], selected: string | null | undefined): { active: string[]; completed: string[]; value: string } {
  const { active, completed } = splitEpics(epics);
  const slugs = epics.map((e) => e.slug);
  return {
    active: active.map((e) => e.slug),
    completed: completed.map((e) => e.slug),
    value: selected && slugs.includes(selected) ? selected : '',
  };
}

export const UNSET_PRIORITY_LABEL = '— unset —';

/**
 * A priority <select>'s options: an unset option (value '', submitted as unset)
 * that reads as an unfinished choice, then the server's levels. `value` is the
 * current level, or '' when unset.
 */
export function priorityOptions(levels: readonly string[], current: string | null | undefined): { options: { value: string; label: string }[]; value: string } {
  return {
    options: [{ value: '', label: UNSET_PRIORITY_LABEL }, ...levels.map((p) => ({ value: p, label: p }))],
    value: current && levels.includes(current) ? current : '',
  };
}

// ---- API paths (relative, segments encoded) ----

const seg = encodeURIComponent;

export const META_PATH = 'api/board/meta';
export const PROJECTS_PATH = 'api/projects';
export const SYNC_PULL_PATH = 'api/sync/pull';
export const CROSS_EPICS_PATH = 'api/epics';

export const cardsPath = (project: string) => `api/board/${seg(project)}/cards`;
export const cardPath = (project: string, id: string) => `${cardsPath(project)}/${seg(id)}`;
/** A card read with its linked plan body (the plan fields ride top-level on the envelope). */
export const cardReadPath = (project: string, id: string) => `${cardPath(project, id)}?includePlan=1`;
export const movePath = (project: string, id: string) => `${cardPath(project, id)}/move`;
export const epicsPath = (project: string) => `api/board/${seg(project)}/epics`;

/**
 * An epic read with its plan body. A cross-project epic has no owning project, so it
 * reads by slug at the top-level route; a project-scoped one reads under its project.
 */
export function epicReadPath(epic: Pick<Epic, 'slug' | 'projects'>, project: string): string {
  return epic.projects
    ? `${CROSS_EPICS_PATH}/${seg(epic.slug)}?includePlan=1`
    : `${epicsPath(project)}/${seg(epic.slug)}?includePlan=1`;
}

/** A card or epic read envelope's top-level plan fields. */
export interface PlanBody {
  body?: string;
  missing?: boolean;
  truncated?: boolean;
}

export function planFromEnvelope(data: { plan_body?: string; plan_missing?: boolean; plan_truncated?: boolean }): PlanBody {
  return { body: data.plan_body, missing: data.plan_missing, truncated: data.plan_truncated };
}
