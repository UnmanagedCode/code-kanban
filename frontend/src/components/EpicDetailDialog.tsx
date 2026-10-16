import { useEffect, useState } from 'react';
import { CircleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { DetailSection, DetailText } from '@/components/DetailSection';
import { PlanSection } from '@/components/PlanSection';
import { RollupPills } from '@/components/RollupPills';
import { useLatest } from '@/hooks/useLatest';
import type { SetStatus } from '@/hooks/useStatus';
import { api } from '@/lib/api';
import { epicReadPath, planFromEnvelope, refusalReason, type Card, type Epic, type PlanBody } from '@/lib/board';

interface EpicDetailDialogProps {
  project: string | null;
  /** The epic row that was opened; null closes the dialog. */
  epic: Epic | null;
  states: readonly string[];
  setStatus: SetStatus;
  onClose: () => void;
}

export function EpicDetailDialog({ project, epic, states, setStatus, onClose }: EpicDetailDialogProps) {
  const shown = useLatest(epic);
  const shownProject = useLatest(project);
  return (
    <Dialog open={!!epic} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[calc(100%-1rem)] p-4 sm:max-w-2xl sm:p-6">
        {shown && shownProject && <EpicDetail key={`${shownProject}/${shown.slug}`} project={shownProject} epic={shown} states={states} setStatus={setStatus} />}
      </DialogContent>
    </Dialog>
  );
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface EpicRead {
  epic: Epic;
  cards: Card[];
  plan_body?: string;
  plan_missing?: boolean;
  plan_truncated?: boolean;
}

function EpicDetail({ project, epic, states, setStatus }: { project: string; epic: Epic; states: readonly string[]; setStatus: SetStatus }) {
  const [loaded, setLoaded] = useState<{ read: EpicRead; plan: PlanBody } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api<EpicRead>(epicReadPath(epic, project)).then(
      (data) => {
        if (!live) return;
        const refused = refusalReason(data);
        if (refused) { setError(refused); setStatus(refused, 'err'); return; }
        setLoaded({ read: data, plan: planFromEnvelope(data) });
      },
      (e) => {
        if (!live) return;
        const msg = `Read epic failed: ${errorText(e)}`;
        setError(msg);
        setStatus(msg, 'err');
      },
    );
    return () => { live = false; };
  }, [project, epic, setStatus]);

  if (!loaded) {
    return (
      <>
        <DialogHeader className="pr-8">
          <DialogTitle className="[overflow-wrap:anywhere]">{epic.title}</DialogTitle>
          <DialogDescription>epic · {epic.slug}</DialogDescription>
        </DialogHeader>
        {error
          ? <Alert variant="destructive"><CircleAlertIcon /><AlertDescription>{error}</AlertDescription></Alert>
          : <div data-skeleton className="flex flex-col gap-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /></div>}
      </>
    );
  }

  const { read, plan } = loaded;
  const cross = read.epic.projects;
  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle className="leading-snug [overflow-wrap:anywhere]">{read.epic.title}</DialogTitle>
        <DialogDescription>epic · {read.epic.slug}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-5">
        {cross && <DetailSection label="Projects"><DetailText text={cross.join(', ')} /></DetailSection>}
        <DetailSection label="Goal"><DetailText text={read.epic.goal} /></DetailSection>
        <DetailSection label="Rollup"><RollupPills states={states} rollup={read.epic.rollup} /></DetailSection>
        <DetailSection label="Cards">
          {read.cards.length
            ? (
              <ul className="flex flex-col gap-1.5">
                {read.cards.map((c) => (
                  <li key={`${c.project ?? ''}/${c.id}`} data-epic-card={c.id} className="flex flex-wrap items-center gap-2 text-sm [overflow-wrap:anywhere]">
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">{c.id}</span>
                    <span>{c.title}</span>
                    <Badge variant="outline">{c.state}</Badge>
                    {cross && <Badge variant="secondary">{c.project}</Badge>}
                  </li>
                ))}
              </ul>
            )
            : <DetailText empty="— none —" />}
        </DetailSection>
        <PlanSection link={read.epic.plan} plan={plan} />
      </div>
    </>
  );
}
