import { useRef } from 'react';

/** `value` while it is set, else the last value it held: what a closing dialog keeps showing. */
export function useLatest<T>(value: T | null | undefined): T | null {
  const last = useRef<T | null>(value ?? null);
  if (value != null) last.current = value;
  return last.current;
}
