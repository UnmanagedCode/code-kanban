// Form submissions as data: each dialog's field values → the request it sends, and
// the sync result → its status line. Pure, so node:test imports it directly.
import { acceptanceFieldForEdit } from './acceptanceEdit.ts';
import { CROSS_EPICS_PATH, epicsPath } from './board.ts';

/** `text` split on `sep`, each part trimmed, empty parts dropped. */
export function splitList(text: string, sep: string): string[] {
  return text.split(sep).map((s) => s.trim()).filter(Boolean);
}

export interface CardFormValues {
  title: string;
  goal: string;
  /** One criterion per line. */
  acceptance: string;
  /** '' for none. */
  epic: string;
  /** '' for unset. */
  priority: string;
  /** Comma-separated ids. */
  depends_on: string;
}

/** POST api/board/<p>/cards body. An empty epic or priority is omitted, never sent. */
export function newCardBody(v: CardFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: v.title.trim(),
    goal: v.goal,
    acceptance: splitList(v.acceptance, '\n'),
    depends_on: splitList(v.depends_on, ','),
  };
  if (v.epic) body.epic = v.epic;
  if (v.priority) body.priority = v.priority;
  return body;
}

/**
 * PATCH api/board/<p>/cards/<id> fields. An empty epic or priority clears it (null);
 * `acceptance` rides only when its text differs from `acceptancePrefill`.
 */
export function editCardFields(v: CardFormValues, acceptancePrefill: string): { fields: Record<string, unknown> } | { error: string } {
  const fields: Record<string, unknown> = {
    title: v.title.trim(),
    goal: v.goal,
    epic: v.epic || null,
    priority: v.priority || null,
    depends_on: splitList(v.depends_on, ','),
  };
  const acceptance = acceptanceFieldForEdit(v.acceptance, acceptancePrefill);
  if (acceptance !== undefined) fields.acceptance = acceptance;
  if (!fields.title) return { error: 'title is required' };
  return { fields };
}

export interface EpicFormValues {
  slug: string;
  title: string;
  goal: string;
  /** The selected "Span projects" members. */
  members: string[];
}

export const ONE_MEMBER_ERROR = 'A cross-project epic needs ≥2 projects; select more, or none for a project-scoped epic.';

/**
 * The create-or-refresh request: ≥2 members → a cross-project epic at the top-level
 * route; none → a project-scoped epic in `current`. Exactly one is ambiguous, so it
 * is refused rather than silently routed to `current`.
 */
export function epicCreateRequest(v: EpicFormValues, current: string): { url: string; body: Record<string, unknown> } | { error: string } {
  const slug = v.slug.trim();
  const title = v.title.trim();
  if (v.members.length === 1) return { error: ONE_MEMBER_ERROR };
  if (v.members.length >= 2) return { url: CROSS_EPICS_PATH, body: { slug, title, goal: v.goal, projects: v.members } };
  return { url: epicsPath(current), body: { slug, title, goal: v.goal } };
}

/** POST api/sync/pull body; `project` rides only for the project scope. */
export function syncPullBody(v: { peerUrl: string; scope: string }, current: string): Record<string, unknown> {
  const scope = v.scope || 'project';
  const body: Record<string, unknown> = { peerUrl: v.peerUrl.trim(), scope };
  if (scope === 'project') body.project = current;
  return body;
}

export interface SyncSummary {
  added?: number;
  updated?: number;
  reassigned?: unknown[];
  epicsAdded?: number;
  epicsUpdated?: number;
  epicConflicts?: unknown[];
  droppedDeps?: unknown[];
  skippedCards?: unknown[];
  skippedEpics?: unknown[];
  skippedProjects?: unknown[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The status line after a pull: counts, then only the clauses that are non-zero. */
export function syncSummaryText(s: SyncSummary = {}): string {
  const bits = [`${s.added || 0} added`, `${s.updated || 0} updated`];
  if (s.reassigned?.length) bits.push(`${s.reassigned.length} re-id’d`);
  if (s.epicsAdded || s.epicsUpdated) bits.push(`epics +${s.epicsAdded || 0}/~${s.epicsUpdated || 0}`);
  if (s.epicConflicts?.length) bits.push(plural(s.epicConflicts.length, 'epic conflict', 'epic conflicts'));
  if (s.droppedDeps?.length) bits.push(`${plural(s.droppedDeps.length, 'dep', 'deps')} dropped`);
  if (s.skippedCards?.length) bits.push(`${s.skippedCards.length} malformed skipped`);
  if (s.skippedEpics?.length) bits.push(`${plural(s.skippedEpics.length, 'epic', 'epics')} skipped`);
  if (s.skippedProjects?.length) bits.push(`${plural(s.skippedProjects.length, 'project', 'projects')} skipped`);
  return `Sync: ${bits.join(', ')}.`;
}
