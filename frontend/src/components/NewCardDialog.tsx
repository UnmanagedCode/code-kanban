import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CardFields, EMPTY_CARD, readCardFields } from '@/components/CardFields';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import type { SetStatus } from '@/hooks/useStatus';
import { api } from '@/lib/api';
import { cardsPath, refusalReason, type Epic } from '@/lib/board';
import { newCardBody } from '@/lib/forms';

interface NewCardDialogProps {
  open: boolean;
  project: string | null;
  epics: readonly Epic[];
  priorities: readonly string[];
  setStatus: SetStatus;
  onClose: () => void;
  onChanged: () => void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function NewCardDialog({ open, ...rest }: NewCardDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) rest.onClose(); }}>
      <DialogContent className="max-w-[calc(100%-1rem)] p-4 sm:max-w-xl sm:p-6">
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
          <DialogDescription>Filed into triage{rest.project ? ` in ${rest.project}` : ''}.</DialogDescription>
        </DialogHeader>
        {open && <NewCardForm {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function NewCardForm({ project, epics, priorities, setStatus, onClose, onChanged }: Omit<NewCardDialogProps, 'open'>) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!project) return;
    setError('');
    setBusy(true);
    let data: { id?: string };
    try {
      data = await api(cardsPath(project), { method: 'POST', body: newCardBody(readCardFields(e.currentTarget)) });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    const refused = refusalReason(data);
    if (refused) { setError(refused); return; }
    setStatus(`Filed ${data.id} into triage.`, 'ok');
    onClose();
    onChanged();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <CardFields defaults={EMPTY_CARD} epics={epics} priorities={priorities} requireTitle />
      <FormError message={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} className="w-full sm:w-auto">Cancel</Button>
        <SubmitButton busy={busy}>File into triage</SubmitButton>
      </DialogFooter>
    </form>
  );
}
