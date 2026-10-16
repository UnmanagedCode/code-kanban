import { useEffect, useState } from 'react';
import { CircleAlertIcon, PencilIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { CardEditForm } from '@/components/CardEditForm';
import { DetailSection, DetailText } from '@/components/DetailSection';
import { MoveForm } from '@/components/MoveForm';
import { PlanSection } from '@/components/PlanSection';
import { useLatest } from '@/hooks/useLatest';
import type { SetStatus } from '@/hooks/useStatus';
import { api } from '@/lib/api';
import {
  cardReadPath, movePath, parseLogLine, planFromEnvelope, refusalReason, transitionsFrom,
  type Card, type Epic, type Meta, type PlanBody,
} from '@/lib/board';

interface CardDetailDialogProps {
  project: string | null;
  /** The card to show; null closes the dialog. */
  cardId: string | null;
  meta: Meta;
  epics: readonly Epic[];
  setStatus: SetStatus;
  onClose: () => void;
  /** After a move or a save: reload the board. */
  onChanged: () => void;
}

export function CardDetailDialog({ project, cardId, ...rest }: CardDetailDialogProps) {
  const shownId = useLatest(cardId);
  const shownProject = useLatest(project);
  return (
    <Dialog open={!!cardId} onOpenChange={(open) => { if (!open) rest.onClose(); }}>
      <DialogContent className="max-w-[calc(100%-1rem)] p-4 sm:max-w-2xl sm:p-6">
        {shownId && shownProject && <CardDetail key={`${shownProject}/${shownId}`} project={shownProject} id={shownId} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Loaded = { card: Card; plan: PlanBody };

function CardDetail({ project, id, meta, epics, setStatus, onClose, onChanged }: Omit<CardDetailDialogProps, 'cardId' | 'project'> & { project: string; id: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ card: Card; plan_body?: string; plan_missing?: boolean; plan_truncated?: boolean }>(cardReadPath(project, id)).then(
      (data) => {
        if (!live) return;
        const refused = refusalReason(data);
        if (refused) { setError(refused); setStatus(refused, 'err'); return; }
        setLoaded({ card: data.card, plan: planFromEnvelope(data) });
      },
      (e) => {
        if (!live) return;
        const msg = `Read card failed: ${errorText(e)}`;
        setError(msg);
        setStatus(msg, 'err');
      },
    );
    return () => { live = false; };
  }, [project, id, setStatus]);

  const move = async (to: string) => {
    let data: { from?: string; to?: string };
    try {
      data = await api(movePath(project, id), { method: 'POST', body: { to } });
    } catch (e) {
      setStatus(`Move failed: ${errorText(e)}`, 'err');
      onClose();
      return;
    }
    const refused = refusalReason(data);
    if (refused) setStatus(`Move refused: ${refused}`, 'err');
    else setStatus(`Moved ${data.from} → ${data.to}.`, 'ok');
    onClose();
    if (!refused) onChanged();
  };

  if (error) {
    return (
      <>
        <DialogHeader className="pr-8">
          <DialogTitle>Card {id}</DialogTitle>
          <DialogDescription>Could not read this card.</DialogDescription>
        </DialogHeader>
        <Alert variant="destructive"><CircleAlertIcon /><AlertDescription>{error}</AlertDescription></Alert>
      </>
    );
  }
  if (!loaded) {
    return (
      <>
        <DialogHeader className="pr-8">
          <DialogTitle>Card {id}</DialogTitle>
          <DialogDescription>Loading…</DialogDescription>
        </DialogHeader>
        <div data-skeleton className="flex flex-col gap-3">
          <Skeleton className="h-4 w-2/3" /><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" />
        </div>
      </>
    );
  }

  const { card, plan } = loaded;
  return (
    <>
      <DialogHeader className="flex-row items-start justify-between gap-3 pr-8">
        <div className="flex min-w-0 flex-col gap-1.5">
          <DialogTitle className="leading-snug [overflow-wrap:anywhere]">{card.title}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <span className="font-mono tabular-nums">{card.id}</span>
            <span aria-hidden>·</span>
            <Badge variant="outline">{card.state}</Badge>
          </DialogDescription>
        </div>
        {!editing && (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}><PencilIcon />Edit</Button>
        )}
      </DialogHeader>
      {editing
        ? (
          <CardEditForm
            project={project}
            card={card}
            epics={epics}
            priorities={meta.priorities}
            onCancel={() => setEditing(false)}
            onSaved={() => { setStatus('Saved.', 'ok'); onClose(); onChanged(); }}
          />
        )
        : (
          <div className="flex flex-col gap-5">
            <DetailSection label="Goal"><DetailText text={card.goal} /></DetailSection>
            {/* Always stated, unset included, so it can never read as "did not load". */}
            <DetailSection label="Priority"><DetailText text={card.priority ?? 'unset'} /></DetailSection>
            <DetailSection label="Acceptance">
              {card.acceptance?.length
                ? (
                  <ul className="flex flex-col gap-1.5">
                    {card.acceptance.map((a, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <Checkbox checked={a.done} disabled aria-label={a.text} className="mt-0.5 disabled:opacity-100" />
                        <span className="[overflow-wrap:anywhere]">{a.text}</span>
                      </li>
                    ))}
                  </ul>
                )
                : <DetailText empty="— none —" />}
            </DetailSection>
            <DetailSection label="Logbook">
              {card.logbook?.length
                ? (
                  <ul className="flex max-h-52 flex-col gap-1 overflow-auto font-mono text-xs text-muted-foreground">
                    {card.logbook.slice().reverse().map((line, i) => {
                      const l = parseLogLine(line);
                      return (
                        <li key={i} className="[overflow-wrap:anywhere]">
                          {l.sid ? <>{l.time} · <span className="text-primary">{l.sid}</span> · {l.rest}</> : l.rest}
                        </li>
                      );
                    })}
                  </ul>
                )
                : <DetailText empty="— empty —" />}
            </DetailSection>
            {card.commit && <DetailSection label="Commit"><p className="font-mono text-sm [overflow-wrap:anywhere]">{card.commit}</p></DetailSection>}
            <PlanSection link={card.plan} plan={plan} />
            <DetailSection label="Move"><MoveForm targets={transitionsFrom(meta, card.state)} onMove={move} /></DetailSection>
          </div>
        )}
    </>
  );
}
