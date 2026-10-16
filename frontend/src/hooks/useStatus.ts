import { useCallback, useEffect, useRef, useState } from 'react';

export type StatusKind = '' | 'ok' | 'err';
export interface Status {
  text: string;
  kind: StatusKind;
}
export type SetStatus = (text: string, kind?: StatusKind) => void;

/** How long an `ok` message stays; `err` and neutral messages stay until replaced. */
const OK_CLEAR_MS = 2500;

/** The status line's message, and its setter (stable across renders). */
export function useStatus(): [Status, SetStatus] {
  const [status, set] = useState<Status>({ text: '', kind: '' });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setStatus = useCallback<SetStatus>((text, kind = '') => {
    clearTimeout(timer.current);
    set({ text, kind });
    if (kind === 'ok') timer.current = setTimeout(() => set({ text: '', kind: '' }), OK_CLEAR_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [status, setStatus];
}
