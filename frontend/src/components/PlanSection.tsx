import type { PlanBody } from '@/lib/board';
import { DetailSection } from '@/components/DetailSection';

/** The linked plan: its link, then its body as plain text (never markup). */
export function PlanSection({ link, plan }: { link?: string | null; plan: PlanBody | null }) {
  if (!link) return null;
  return (
    <DetailSection label="Plan">
      <p data-plan-link className="font-mono text-xs text-plan [overflow-wrap:anywhere]">{link}</p>
      {plan?.missing
        ? <p className="text-sm text-muted-foreground italic">(file not found)</p>
        : <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs break-words whitespace-pre-wrap">{plan?.body || '—'}</pre>}
      {plan?.truncated && <p className="text-sm text-muted-foreground italic">(truncated)</p>}
    </DetailSection>
  );
}
