import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { CardFields, readCardFields } from '@/components/CardFields';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { api } from '@/lib/api';
import { cardPath, refusalReason, type Card, type Epic } from '@/lib/board';
import { editCardFields, type CardFormValues } from '@/lib/forms';

interface CardEditFormProps {
  project: string;
  card: Card;
  epics: readonly Epic[];
  priorities: readonly string[];
  onSaved: () => void;
  onCancel: () => void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The logbook, commit and plan link are not editable here: the plan link is set by
// the conductor or a plan worker, never typed into the GUI.
export function CardEditForm({ project, card, epics, priorities, onSaved, onCancel }: CardEditFormProps) {
  // Captured when the form is built, so an untouched acceptance textarea can be told
  // from an edited one at submit time (lib/acceptanceEdit.ts).
  const [defaults] = useState<CardFormValues>(() => ({
    title: card.title,
    goal: card.goal || '',
    acceptance: (card.acceptance || []).map((a) => a.text).join('\n'),
    epic: card.epic || '',
    priority: card.priority || '',
    depends_on: (card.depends_on || []).join(', '),
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const r = editCardFields(readCardFields(e.currentTarget), defaults.acceptance);
    if ('error' in r) { setError(r.error); return; }
    setBusy(true);
    let data: unknown;
    try {
      data = await api(cardPath(project, card.id), { method: 'PATCH', body: r.fields });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return;
    }
    const refused = refusalReason(data);
    setBusy(false);
    if (refused) { setError(refused); return; }
    onSaved();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <CardFields
        defaults={defaults}
        epics={epics}
        priorities={priorities}
        acceptanceHint="Ticked criteria keep their tick when the text is unchanged. Empty clears the list."
      />
      <FormError message={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} className="w-full sm:w-auto">Cancel</Button>
        <SubmitButton busy={busy}>Save</SubmitButton>
      </DialogFooter>
    </form>
  );
}
