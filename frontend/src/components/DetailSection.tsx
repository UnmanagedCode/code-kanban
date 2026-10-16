import type { ReactNode } from 'react';

export function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</h3>
      {children}
    </section>
  );
}

/** Section text, or a muted dash when empty. */
export function DetailText({ text, empty = '—' }: { text?: string | null; empty?: string }) {
  return text
    ? <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
    : <p className="text-sm text-muted-foreground italic">{empty}</p>;
}
