import { useId, useState, type FormEvent } from 'react';
import { CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Field, fieldValue } from '@/components/Field';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import type { SetStatus } from '@/hooks/useStatus';
import { api } from '@/lib/api';
import { refusalReason, SYNC_PULL_PATH } from '@/lib/board';
import { syncPullBody, syncSummaryText, type SyncSummary } from '@/lib/forms';

interface SyncDialogProps {
  open: boolean;
  project: string | null;
  setStatus: SetStatus;
  onClose: () => void;
  onChanged: () => void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SyncDialog({ open, ...rest }: SyncDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) rest.onClose(); }}>
      <DialogContent className="max-w-[calc(100%-1rem)] p-4 sm:max-w-xl sm:p-6">
        <DialogHeader>
          <DialogTitle>Sync board</DialogTitle>
          <DialogDescription>Pull another instance’s board and merge it into this one.</DialogDescription>
        </DialogHeader>
        {open && <SyncForm {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

// A two-click, one-way pull. This board's own URL comes from the browser: the
// backend cannot know the forwarded URL it is reached through, but the browser
// reached the board through it. The peer pastes it on their side.
function SyncForm({ project, setStatus, onClose, onChanged }: Omit<SyncDialogProps, 'open'>) {
  const id = useId();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ownUrl = location.origin + location.pathname;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ownUrl);
      setStatus('Board URL copied.', 'ok');
    } catch {
      setStatus('Copy failed — select the URL manually.', 'err');
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!project) return;
    const form = e.currentTarget;
    const body = syncPullBody({ peerUrl: fieldValue(form, 'peerUrl'), scope: fieldValue(form, 'scope') }, project);
    setError('');
    setBusy(true);
    let data: { summary?: SyncSummary };
    try {
      data = await api(SYNC_PULL_PATH, { method: 'POST', body });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    const refused = refusalReason(data);
    if (refused) { setError(refused); return; }
    setStatus(syncSummaryText(data.summary), 'ok');
    onClose();
    onChanged();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field id={`${id}-own`} label="This board’s URL (share with the peer)">
        <div className="flex gap-2">
          <Input id={`${id}-own`} name="own" readOnly value={ownUrl} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs md:text-xs" />
          <Button type="button" variant="outline" onClick={copy}><CopyIcon />Copy</Button>
        </div>
      </Field>
      <Field id={`${id}-peer`} label="Peer board URL">
        <Input id={`${id}-peer`} name="peerUrl" required placeholder="https://… (the peer’s board URL)" />
      </Field>
      <Field id={`${id}-scope`} label="Scope">
        <NativeSelect id={`${id}-scope`} name="scope" defaultValue="project" className="w-full">
          <option value="project">This project ({project})</option>
          <option value="all">All projects</option>
        </NativeSelect>
      </Field>
      <p className="text-xs text-muted-foreground">Pulls the peer’s cards and merges them in (newer edit wins). One-way per click — click Sync on the peer too to converge.</p>
      <FormError message={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} className="w-full sm:w-auto">Cancel</Button>
        <SubmitButton busy={busy}>Pull from peer</SubmitButton>
      </DialogFooter>
    </form>
  );
}
