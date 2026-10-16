import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Field, fieldValue } from '@/components/Field';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import type { SetStatus } from '@/hooks/useStatus';
import { api } from '@/lib/api';
import { refusalReason } from '@/lib/board';
import { epicCreateRequest } from '@/lib/forms';

interface NewEpicDialogProps {
  open: boolean;
  project: string | null;
  projects: readonly string[];
  setStatus: SetStatus;
  onClose: () => void;
  onChanged: () => void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function NewEpicDialog({ open, project, projects, setStatus, onClose, onChanged }: NewEpicDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100%-1rem)] p-4 sm:max-w-xl sm:p-6">
        <DialogHeader>
          <DialogTitle>New epic</DialogTitle>
          <DialogDescription>Create an epic, or refresh an existing slug’s title and goal.</DialogDescription>
        </DialogHeader>
        {open && <NewEpicForm project={project} projects={projects} setStatus={setStatus} onClose={onClose} onChanged={onChanged} />}
      </DialogContent>
    </Dialog>
  );
}

// Selecting ≥2 member projects makes a cross-project epic; none makes a
// project-scoped one in the current project.
function NewEpicForm({ project, projects, setStatus, onClose, onChanged }: Omit<NewEpicDialogProps, 'open'>) {
  const id = useId();
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (p: string, on: boolean) =>
    setMembers((cur) => (on ? projects.filter((x) => x === p || cur.includes(x)) : cur.filter((x) => x !== p)));

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!project) return;
    const form = e.currentTarget;
    const v = { slug: fieldValue(form, 'slug'), title: fieldValue(form, 'title'), goal: fieldValue(form, 'goal'), members };
    const req = epicCreateRequest(v, project);
    if ('error' in req) { setError(req.error); return; }
    setError('');
    setBusy(true);
    let data: unknown;
    try {
      data = await api(req.url, { method: 'POST', body: req.body });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    const refused = refusalReason(data);
    if (refused) { setError(refused); return; }
    setStatus(`Epic ${v.slug.trim()} saved.`, 'ok');
    onClose();
    onChanged();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field id={`${id}-slug`} label="Slug">
        <Input id={`${id}-slug`} name="slug" required pattern="^[a-z0-9._-]+$" placeholder="lowercase, e.g. auth-flow" />
      </Field>
      <Field id={`${id}-title`} label="Title">
        <Input id={`${id}-title`} name="title" required />
      </Field>
      <Field id={`${id}-goal`} label="Goal">
        <Textarea id={`${id}-goal`} name="goal" rows={3} />
      </Field>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">Span projects (≥2 → cross-project)</legend>
        <div className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-md border p-2.5">
          {projects.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <Checkbox id={`${id}-p-${p}`} checked={members.includes(p)} onCheckedChange={(on) => toggle(p, on === true)} />
              <Label htmlFor={`${id}-p-${p}`} className="font-normal [overflow-wrap:anywhere]">{p}</Label>
            </div>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">Creating an existing slug refreshes its title/goal (upsert). Leave Span empty for a project-scoped epic.</p>
      <FormError message={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} className="w-full sm:w-auto">Cancel</Button>
        <SubmitButton busy={busy}>Create / refresh</SubmitButton>
      </DialogFooter>
    </form>
  );
}
