import { ArrowDownUpIcon, LayersIcon, PlusIcon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

interface ToolbarProps {
  projects: string[];
  current: string | null;
  onSelect: (project: string) => void;
  planOnly: boolean;
  onPlanOnly: (on: boolean) => void;
  loading: boolean;
  onNewCard: () => void;
  onNewEpic: () => void;
  onSync: () => void;
  onRefresh: () => void;
}

// DOM order is the tab order (select, Has plan, New card, New epic, Sync, Refresh);
// on a phone `order` lifts Refresh onto the title's row.
export function Toolbar(p: ToolbarProps) {
  const off = !p.current;
  return (
    <header className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-4 py-2.5 text-card-foreground">
      <h1 className="mr-auto text-base font-semibold tracking-tight sm:mr-0">Code Kanban</h1>
      <div className="order-2 flex w-full min-w-0 items-center gap-2 sm:order-none sm:w-auto">
        <Label htmlFor="project-select" className="text-muted-foreground">Project</Label>
        <NativeSelect
          id="project-select"
          value={p.current ?? ''}
          onChange={(e) => p.onSelect(e.target.value)}
          className="flex-1 sm:w-56 sm:flex-none"
        >
          <option value="" disabled>— select —</option>
          {p.projects.map((name) => <option key={name} value={name}>{name}</option>)}
        </NativeSelect>
      </div>
      <div className="order-3 flex flex-wrap items-center gap-2 sm:order-none">
        <div className="flex items-center gap-2 pr-1" title="Show only cards carrying a plan link">
          <Checkbox id="plan-filter" checked={p.planOnly} onCheckedChange={(v) => p.onPlanOnly(v === true)} />
          <Label htmlFor="plan-filter">Has plan</Label>
        </div>
        <Button type="button" variant="outline" disabled={off} onClick={p.onNewCard}><PlusIcon />New card</Button>
        <Button type="button" variant="outline" disabled={off} onClick={p.onNewEpic}><LayersIcon />New epic</Button>
        <Button type="button" variant="outline" disabled={off} onClick={p.onSync}><ArrowDownUpIcon />Sync</Button>
      </div>
      <Button type="button" variant="ghost" size="icon" aria-label="Refresh" title="Refresh" disabled={off} onClick={p.onRefresh} className="order-1 sm:order-none">
        <RefreshCwIcon className={cn(p.loading && 'animate-spin')} />
      </Button>
    </header>
  );
}
