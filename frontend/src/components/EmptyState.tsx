import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('px-1 py-2 text-sm text-muted-foreground', className)}>{children}</p>;
}
