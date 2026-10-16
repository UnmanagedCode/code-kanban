import { Lane } from '@/components/Lane';
import { Skeleton } from '@/components/ui/skeleton';
import { laneCards, type Card } from '@/lib/board';

interface BoardProps {
  /** `meta.states`; null until the catalog has loaded. */
  states: string[] | null;
  cards: Card[];
  pending: boolean;
  /** A load is in flight (a reload keeps the current lists on screen meanwhile). */
  loading: boolean;
  planOnly: boolean;
  onOpen: (id: string) => void;
}

// At `lg` and up the board takes the height left after the epics pane (basis 0
// keeps lane content out of that calculation) and each lane scrolls inside it;
// min-height is the short-window floor, below which `main` scrolls the page.
// Narrower, the lanes wrap into rows and the board is content height.
const GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:min-h-[260px] lg:flex-1 lg:basis-0 lg:grid-cols-5';

const PLACEHOLDER_LANES = 5;

export function Board({ states, cards, pending, loading, planOnly, onOpen }: BoardProps) {
  if (!states) {
    return (
      <section aria-label="Board" aria-busy="true" className={GRID}>
        {Array.from({ length: PLACEHOLDER_LANES }, (_, i) => <Skeleton key={i} data-skeleton className="min-h-[120px] rounded-xl" />)}
      </section>
    );
  }
  // Lanes are keyed by state and stay mounted across reloads, so each keeps its
  // scroll offset; never swap them out while a reload is in flight.
  return (
    <section aria-label="Board" aria-busy={pending || undefined} data-loading={loading || undefined} className={GRID}>
      {states.map((s) => (
        <Lane key={s} state={s} cards={laneCards(cards, s, planOnly)} pending={pending} planOnly={planOnly} onOpen={onOpen} />
      ))}
    </section>
  );
}
