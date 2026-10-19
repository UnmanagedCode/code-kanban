import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { PlanBody } from '@/lib/board';
import { parsePlan } from '@/lib/planMarkdown';
import { DetailSection } from '@/components/DetailSection';
import { PlanMarkdown } from '@/components/PlanMarkdown';

type View = 'markdown' | 'raw';
const RAW_CLASS = 'max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs break-words whitespace-pre-wrap';
const VIEWS: { view: View; label: string }[] = [{ view: 'markdown', label: 'Markdown' }, { view: 'raw', label: 'Raw' }];

/**
 * The linked plan: its link, then its body rendered as Markdown (never markup) or,
 * toggled, as the raw text. The view is component state only: every open of the
 * dialog starts in Markdown.
 */
export function PlanSection({ link, plan }: { link?: string | null; plan: PlanBody | null }) {
  const [view, setView] = useState<View>('markdown');
  const body = plan && !plan.missing ? plan.body ?? '' : '';
  const blocks = useMemo(() => parsePlan(body), [body]);
  if (!link) return null;
  const toggle = blocks.length > 0 && (
    <div role="group" aria-label="Plan view" className="flex gap-1">
      {VIEWS.map((v) => (
        <Button key={v.view} type="button" size="sm" variant={view === v.view ? 'secondary' : 'ghost'} aria-pressed={view === v.view} className="h-6 px-2 text-xs" onClick={() => setView(v.view)}>
          {v.label}
        </Button>
      ))}
    </div>
  );
  return (
    <DetailSection label="Plan" aside={toggle || undefined}>
      <p data-plan-link className="font-mono text-xs text-plan [overflow-wrap:anywhere]">{link}</p>
      {plan?.missing
        ? <p className="text-sm text-muted-foreground italic">(file not found)</p>
        : blocks.length === 0
          ? <pre className={RAW_CLASS}>—</pre>
          : view === 'markdown'
            ? <div data-plan-body="markdown" className="max-h-96 space-y-2 overflow-auto rounded-md border bg-muted/40 p-3 text-sm [overflow-wrap:anywhere]"><PlanMarkdown blocks={blocks} /></div>
            : <pre data-plan-body="raw" className={RAW_CLASS}>{body}</pre>}
      {plan?.truncated && <p className="text-sm text-muted-foreground italic">(truncated)</p>}
    </DetailSection>
  );
}
