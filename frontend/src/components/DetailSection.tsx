import type { ReactNode } from 'react';

/** A labelled dialog section; `aside` (a control) sits at the heading's right. */
export function DetailSection({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  const heading = <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</h3>;
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      {aside ? <div data-section-head className="flex items-center justify-between gap-2">{heading}{aside}</div> : heading}
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
