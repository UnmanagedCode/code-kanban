import { useId } from 'react';
import { Badge } from '@/components/ui/badge';
import { badgedPriority, PRIORITY_BADGE, type Card } from '@/lib/board';

export function CardTile({ card, onOpen }: { card: Card; onOpen: (id: string) => void }) {
  const metaId = useId();
  const badges = [
    card.epic && <Badge key="epic" data-badge="epic" variant="outline">{card.epic}</Badge>,
    badgedPriority(card.priority) && (
      <Badge key="priority" data-badge="priority" variant={PRIORITY_BADGE[card.priority] ?? 'outline'}>{card.priority.toLowerCase()}</Badge>
    ),
    card.owner && <Badge key="owner" data-badge="owner" variant="info">{card.owner}</Badge>,
    card.plan && <Badge key="plan" data-badge="plan" variant="plan" title={card.plan}>plan</Badge>,
  ].filter(Boolean);
  return (
    <button
      type="button"
      data-card-id={card.id}
      aria-label={`${card.id} ${card.title}`}
      aria-describedby={badges.length ? metaId : undefined}
      onClick={() => onOpen(card.id)}
      className="flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border bg-background px-2.5 py-2 text-left text-sm shadow-xs transition-colors outline-none [overflow-wrap:anywhere] hover:border-primary/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="font-mono text-xs text-muted-foreground tabular-nums">{card.id}</span>
      <span className="font-medium">{card.title}</span>
      {badges.length > 0 && <span id={metaId} className="flex flex-wrap items-center gap-1.5">{badges}</span>}
    </button>
  );
}
