import { useId, useState, type FormEvent } from 'react';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/SubmitButton';

/** The legal move targets and the Move commit; `onMove` resolves once the move settles. */
export function MoveForm({ targets, onMove }: { targets: string[]; onMove: (to: string) => Promise<void> }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const to = (e.currentTarget.elements.namedItem('to') as HTMLSelectElement).value;
    if (!to) return;
    setBusy(true);
    try { await onMove(to); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor={id}>Move to</Label>
        <NativeSelect id={id} name="to" defaultValue={targets[0] ?? ''} className="w-full">
          {targets.length
            ? targets.map((s) => <option key={s} value={s}>{s}</option>)
            : <option value="" disabled>no legal moves</option>}
        </NativeSelect>
      </div>
      <SubmitButton busy={busy} disabled={!targets.length}>Move</SubmitButton>
    </form>
  );
}
