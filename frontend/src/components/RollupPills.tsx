import { rollupPills, type Rollup } from '@/lib/board';

export function RollupPills({ states, rollup }: { states: readonly string[]; rollup: Rollup | undefined }) {
  return (
    <div className="flex flex-wrap gap-1">
      {rollupPills(states, rollup).map((p) => (
        <span
          key={p.state}
          data-rollup={p.state}
          data-zero={String(p.zero)}
          className="rounded-full border px-1.5 py-px text-xs text-muted-foreground tabular-nums data-[zero=true]:opacity-40"
        >
          {p.label}: <b className="font-semibold text-foreground">{p.count}</b>
        </span>
      ))}
    </div>
  );
}
