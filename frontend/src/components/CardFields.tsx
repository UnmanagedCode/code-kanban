import { useId } from 'react';
import { Field, fieldValue } from '@/components/Field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { epicOptions, priorityOptions, type Epic } from '@/lib/board';
import type { CardFormValues } from '@/lib/forms';

interface CardFieldsProps {
  defaults: CardFormValues;
  epics: readonly Epic[];
  priorities: readonly string[];
  /** The new-card form requires a title natively; the edit form reports it itself. */
  requireTitle?: boolean;
  acceptanceHint?: string;
}

/** The card fields both the new-card and edit forms submit, named as `CardFormValues`. */
export function CardFields({ defaults, epics, priorities, requireTitle, acceptanceHint }: CardFieldsProps) {
  const id = useId();
  const epic = epicOptions(epics, defaults.epic);
  const priority = priorityOptions(priorities, defaults.priority);
  return (
    <>
      <Field id={`${id}-title`} label="Title">
        <Input id={`${id}-title`} name="title" defaultValue={defaults.title} required={requireTitle} />
      </Field>
      <Field id={`${id}-goal`} label="Goal">
        <Textarea id={`${id}-goal`} name="goal" rows={3} defaultValue={defaults.goal} />
      </Field>
      <Field id={`${id}-acceptance`} label="Acceptance (one per line)" hint={acceptanceHint}>
        <Textarea id={`${id}-acceptance`} name="acceptance" rows={3} defaultValue={defaults.acceptance} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-epic`} label="Epic">
          <NativeSelect id={`${id}-epic`} name="epic" defaultValue={epic.value} className="w-full">
            <option value="">— none —</option>
            {epic.active.map((s) => <option key={s} value={s}>{s}</option>)}
            {epic.completed.length > 0 && (
              <optgroup label="Completed">
                {epic.completed.map((s) => <option key={s} value={s}>{s}</option>)}
              </optgroup>
            )}
          </NativeSelect>
        </Field>
        <Field id={`${id}-priority`} label="Priority">
          <NativeSelect id={`${id}-priority`} name="priority" defaultValue={priority.value} className="w-full">
            {priority.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id={`${id}-deps`} label="Depends on (comma-separated ids)">
        <Input id={`${id}-deps`} name="depends_on" defaultValue={defaults.depends_on} />
      </Field>
    </>
  );
}

/** The submitted form's card fields. */
export function readCardFields(form: HTMLFormElement): CardFormValues {
  const v = (k: string) => fieldValue(form, k);
  return { title: v('title'), goal: v('goal'), acceptance: v('acceptance'), epic: v('epic'), priority: v('priority'), depends_on: v('depends_on') };
}

export const EMPTY_CARD: CardFormValues = { title: '', goal: '', acceptance: '', epic: '', priority: '', depends_on: '' };
