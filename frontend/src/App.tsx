import { useCallback, useEffect, useState } from 'react';
import { CircleAlertIcon, RefreshCwIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Board } from '@/components/Board';
import { CardDetailDialog } from '@/components/CardDetailDialog';
import { EmptyState } from '@/components/EmptyState';
import { EpicDetailDialog } from '@/components/EpicDetailDialog';
import { EpicsPane } from '@/components/EpicsPane';
import { NewCardDialog } from '@/components/NewCardDialog';
import { NewEpicDialog } from '@/components/NewEpicDialog';
import { StatusLine } from '@/components/StatusLine';
import { SyncDialog } from '@/components/SyncDialog';
import { Toolbar } from '@/components/Toolbar';
import { useBoard } from '@/hooks/useBoard';
import { useStatus } from '@/hooks/useStatus';
import { api } from '@/lib/api';
import { META_PATH, PROJECTS_PATH, type Epic, type Meta } from '@/lib/board';
import { readSelectedProject, resolveInitialProject, writeSelectedProject } from '@/lib/persist';

/** At most one overlay is open. */
type DialogState =
  | { kind: 'card'; id: string }
  | { kind: 'epic'; epic: Epic }
  | { kind: 'newCard' }
  | { kind: 'newEpic' }
  | { kind: 'sync' }
  | null;

type Init = { phase: 'loading' } | { phase: 'failed'; message: string } | { phase: 'ready'; meta: Meta; projects: string[] };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const [status, setStatus] = useStatus();
  const [init, setInit] = useState<Init>({ phase: 'loading' });
  const [current, setCurrent] = useState<string | null>(null);
  const [planOnly, setPlanOnly] = useState(false); // session-only, deliberately not persisted
  const [dialog, setDialog] = useState<DialogState>(null);
  const board = useBoard(current, setStatus);

  const selectProject = useCallback((name: string | null) => {
    setCurrent(name || null);
    writeSelectedProject(name || null);
  }, []);

  const initialize = useCallback(async () => {
    setInit({ phase: 'loading' });
    let meta: Meta;
    let projects: string[];
    try {
      const [metaRes, projRes] = await Promise.all([api<Meta>(META_PATH), api<{ projects?: string[] }>(PROJECTS_PATH)]);
      meta = metaRes;
      projects = projRes.projects || [];
    } catch (e) {
      const message = `Failed to initialize: ${errorText(e)}`;
      setInit({ phase: 'failed', message });
      setStatus(message, 'err');
      return;
    }
    setInit({ phase: 'ready', meta, projects });
    const target = resolveInitialProject(projects, readSelectedProject());
    if (target) selectProject(target);
    else setStatus('No projects available.');
  }, [selectProject, setStatus]);

  useEffect(() => { void initialize(); }, [initialize]);

  const close = useCallback(() => setDialog(null), []);
  const changed = useCallback(() => { void board.reload(); }, [board.reload]);

  const meta = init.phase === 'ready' ? init.meta : null;
  const projects = init.phase === 'ready' ? init.projects : [];

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        projects={projects}
        current={current}
        onSelect={selectProject}
        planOnly={planOnly}
        onPlanOnly={setPlanOnly}
        loading={board.loading}
        onNewCard={() => setDialog({ kind: 'newCard' })}
        onNewEpic={() => setDialog({ kind: 'newEpic' })}
        onSync={() => setDialog({ kind: 'sync' })}
        onRefresh={() => { void board.reload(true); }}
      />
      <StatusLine status={status} />
      <main className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pt-3 pb-8">
        {init.phase === 'failed' && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>The board could not load</AlertTitle>
            <AlertDescription>
              <p>{init.message}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => { void initialize(); }}><RefreshCwIcon />Retry</Button>
            </AlertDescription>
          </Alert>
        )}
        {init.phase === 'loading' && <Board states={null} cards={[]} pending loading planOnly={false} onOpen={() => {}} />}
        {meta && projects.length === 0 && <EmptyState>No projects available.</EmptyState>}
        {meta && current && (
          <>
            <Board states={meta.states} cards={board.cards} pending={board.pending} loading={board.loading} planOnly={planOnly} onOpen={(id) => setDialog({ kind: 'card', id })} />
            <EpicsPane epics={board.epics} states={meta.states} pending={board.pending} onOpen={(epic) => setDialog({ kind: 'epic', epic })} />
          </>
        )}
      </main>

      {meta && (
        <>
          <CardDetailDialog
            project={current}
            cardId={dialog?.kind === 'card' ? dialog.id : null}
            meta={meta}
            epics={board.epics}
            setStatus={setStatus}
            onClose={close}
            onChanged={changed}
          />
          <EpicDetailDialog
            project={current}
            epic={dialog?.kind === 'epic' ? dialog.epic : null}
            states={meta.states}
            setStatus={setStatus}
            onClose={close}
          />
          <NewCardDialog open={dialog?.kind === 'newCard'} project={current} epics={board.epics} priorities={meta.priorities} setStatus={setStatus} onClose={close} onChanged={changed} />
          <NewEpicDialog open={dialog?.kind === 'newEpic'} project={current} projects={projects} setStatus={setStatus} onClose={close} onChanged={changed} />
          <SyncDialog open={dialog?.kind === 'sync'} project={current} setStatus={setStatus} onClose={close} onChanged={changed} />
        </>
      )}
    </div>
  );
}
