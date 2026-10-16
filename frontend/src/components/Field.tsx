import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';

/** A labelled form control, with an optional hint under it. */
export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A named control's current value. Read from the element, not FormData, so a textarea's newlines are never normalised. */
export function fieldValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  return el && 'value' in el ? String(el.value) : '';
}
