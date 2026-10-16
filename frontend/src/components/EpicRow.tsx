import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RollupPills } from '@/components/RollupPills';
import type { Epic } from '@/lib/board';

export function EpicRow({ epic, states, onOpen }: { epic: Epic; states: readonly string[]; onOpen: (e: Epic) => void }) {
  return (
    <div
      data-epic-slug={epic.slug}
      className="grid grid-cols-1 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-card-foreground sm:grid-cols-[minmax(120px,220px)_1fr_auto] sm:gap-2.5"
    >
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          <span>{epic.title}</span>
          {epic.projects && <Badge data-badge="cross" variant="info">cross-project</Badge>}
          {epic.plan && <Badge data-badge="plan" variant="plan" title={epic.plan}>plan</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">{epic.projects ? `${epic.slug} · ${epic.projects.join(', ')}` : epic.slug}</div>
      </div>
      <RollupPills states={states} rollup={epic.rollup} />
      <Button type="button" variant="outline" size="sm" aria-label={`Open epic ${epic.slug}`} onClick={() => onOpen(epic)} className="justify-self-start sm:justify-self-end">
        Open
      </Button>
    </div>
  );
}
