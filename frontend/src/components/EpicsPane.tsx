import { EmptyState } from '@/components/EmptyState';
import { EpicRow } from '@/components/EpicRow';
import { Skeleton } from '@/components/ui/skeleton';
import { splitEpics, type Epic } from '@/lib/board';

// Capped at a quarter of the viewport with its own scroller, at every width;
// min-height keeps the header and part of a row visible when the board's own floor
// squeezes the page.
interface EpicsPaneProps {
  epics: Epic[];
  states: readonly string[];
  /** The project's lists have not arrived yet. */
  pending: boolean;
  onOpen: (e: Epic) => void;
}

export function EpicsPane({ epics, states, pending, onOpen }: EpicsPaneProps) {
  const { active, completed } = splitEpics(epics);
  return (
    <section aria-labelledby="epics-heading" className="flex max-h-[25vh] min-h-[72px] flex-none flex-col gap-2 overflow-x-hidden overflow-y-auto">
      <h2 id="epics-heading" className="text-sm font-semibold">Epics</h2>
      {pending
        ? <Skeleton data-skeleton className="h-12 w-full rounded-lg" />
        : epics.length === 0
        ? <EmptyState className="py-0">No epics yet.</EmptyState>
        : (
          <div className="flex flex-col gap-1.5">
            {active.map((e) => <EpicRow key={e.slug} epic={e} states={states} onOpen={onOpen} />)}
            {completed.length > 0 && (
              <div role="separator" aria-label={`Completed · ${completed.length}`} className="mt-0.5 border-t pt-1 text-xs tracking-wide text-muted-foreground">
                Completed · {completed.length}
              </div>
            )}
            {completed.map((e) => <EpicRow key={e.slug} epic={e} states={states} onOpen={onOpen} />)}
          </div>
        )}
    </section>
  );
}
