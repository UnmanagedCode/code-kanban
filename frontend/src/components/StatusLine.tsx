import { CircleAlertIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Status } from '@/hooks/useStatus';

export function StatusLine({ status }: { status: Status }) {
  return (
    <p
      role="status"
      aria-live="polite"
      data-kind={status.kind || undefined}
      className={cn(
        'flex min-h-8 items-center gap-1.5 px-4 py-1.5 text-xs text-muted-foreground',
        status.kind === 'err' && 'text-destructive',
        status.kind === 'ok' && 'text-success',
      )}
    >
      {status.kind === 'err' && <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />}
      <span>{status.text}</span>
    </p>
  );
}
