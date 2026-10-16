import type { ReactNode } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A form's one committing action: disabled with a spinner while busy. */
export function SubmitButton({ busy, disabled, className, children }: { busy: boolean; disabled?: boolean; className?: string; children: ReactNode }) {
  return (
    <Button type="submit" disabled={busy || disabled} className={cn('w-full sm:w-auto', className)}>
      {busy && <LoaderCircleIcon className="animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}
