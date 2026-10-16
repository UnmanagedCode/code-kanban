import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CardTile } from '@/components/CardTile';
import { LANE_ACCENT, laneLabel, type Card } from '@/lib/board';
import { cn } from '@/lib/utils';

interface LaneProps {
  state: string;
  cards: Card[];
  /** The project's lists have not arrived: placeholder tiles instead of cards. */
  pending: boolean;
  planOnly: boolean;
  onOpen: (id: string) => void;
}

// The body is the lane's own scroller at `lg` and up, where the board has a fixed
// height. `overflow-x-hidden` is explicit because setting only overflow-y computes
// overflow-x to `auto`.
export function Lane({ state, cards, pending, planOnly, onOpen }: LaneProps) {
  const headingId = `lane-${state}`;
  return (
    <section
      data-lane={state}
      aria-labelledby={headingId}
      className={cn('flex min-h-[120px] min-w-0 flex-col rounded-xl border border-t-4 bg-card text-card-foreground', LANE_ACCENT[state])}
    >
      <header data-lane-head className="z-10 flex flex-none items-center justify-between gap-2 rounded-t-xl bg-card px-3 py-2 max-sm:sticky max-sm:top-0">
        <h2 id={headingId} className="text-sm font-semibold">{laneLabel(state)}</h2>
        <Badge variant="outline" className="text-muted-foreground tabular-nums">{pending ? '…' : cards.length}</Badge>
      </header>
      <div data-lane-body className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto overscroll-y-contain px-2.5 pt-1 pb-3">
        {pending
          ? [0, 1].map((i) => <Skeleton key={i} data-skeleton className="h-16 w-full" />)
          : cards.length
            ? cards.map((c) => <CardTile key={c.id} card={c} onOpen={onOpen} />)
            : <p data-empty className="px-0.5 py-1.5 text-xs text-muted-foreground italic">{planOnly ? 'No planned cards' : 'No cards'}</p>}
      </div>
    </section>
  );
}
