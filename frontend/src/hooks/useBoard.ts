import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cardsPath, epicsPath, refusalReason, type Card, type Epic } from '@/lib/board';
import type { SetStatus } from '@/hooks/useStatus';

interface Lists {
  /** The project these lists belong to. */
  project: string | null;
  cards: Card[];
  epics: Epic[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The selected project's cards and epics. A project switch empties the lists
 * (`pending` until they arrive); `reload()` keeps them on screen while it fetches, so
 * the lanes stay mounted and each keeps its scroll offset. A response for anything but
 * the latest request is dropped, so switching fast never shows a stale project.
 */
export function useBoard(project: string | null, setStatus: SetStatus) {
  const [lists, setLists] = useState<Lists>({ project: null, cards: [], epics: [] });
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // `announce`: report "Loading…" and the loaded counts. A reload after a mutation
  // does not, so the mutation's own status message stays readable.
  const load = useCallback(async (p: string, announce: boolean) => {
    const n = ++seq.current;
    setLoading(true);
    if (announce) setStatus('Loading…');
    try {
      const [cardsRes, epicsRes] = await Promise.all([
        api<{ ok: boolean; cards?: Card[] }>(cardsPath(p)),
        api<{ ok: boolean; epics?: Epic[] }>(epicsPath(p)),
      ]);
      if (n !== seq.current) return;
      const refused = refusalReason(cardsRes);
      if (refused) {
        setLists({ project: p, cards: [], epics: [] });
        setStatus(refused, 'err');
        return;
      }
      const cards = cardsRes.cards || [];
      const epics = epicsRes.ok ? (epicsRes.epics || []) : [];
      setLists({ project: p, cards, epics });
      if (announce) setStatus(`Loaded ${cards.length} card(s) across ${epics.length} epic(s).`, 'ok');
    } catch (e) {
      if (n !== seq.current) return;
      // A failed reload keeps what is on screen; a failed switch shows the new project empty.
      setLists((cur) => (cur.project === p ? cur : { project: p, cards: [], epics: [] }));
      setStatus(`Load failed: ${errorText(e)}`, 'err');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [setStatus]);

  useEffect(() => {
    if (project) {
      void load(project, true);
    } else {
      seq.current++;
      setLoading(false);
    }
  }, [project, load]);

  const reload = useCallback((announce = false) => (project ? load(project, announce) : Promise.resolve()), [project, load]);

  const current = lists.project === project;
  return {
    cards: current ? lists.cards : [],
    epics: current ? lists.epics : [],
    /** The lists for `project` have not arrived yet. */
    pending: !!project && !current,
    loading,
    reload,
  };
}
