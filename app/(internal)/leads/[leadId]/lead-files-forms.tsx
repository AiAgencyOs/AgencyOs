'use client';

import { useActionState, useId } from 'react';

import { addLeadFileAction, removeLeadFileAction } from '@/modules/crm/lead-files-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass } from '@/ui';

/** Lead 360 › Files — keep a link on the lead (decision 11). The door re-checks the role. */
export function AddLeadFileForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(addLeadFileAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
        <label htmlFor={`${id}-title`} className={labelClass}>
          Title
        </label>
        <input id={`${id}-title`} name="title" required maxLength={200} placeholder="e.g. Brand guidelines" className={inputClass} />
      </div>
      <div className="flex min-w-[12rem] flex-[2] flex-col gap-1">
        <label htmlFor={`${id}-url`} className={labelClass}>
          Link
        </label>
        <input id={`${id}-url`} name="url" type="url" required placeholder="https://…" className={inputClass} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Adding…' : 'Add File'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full" />
    </form>
  );
}

export function RemoveLeadFileButton({ leadId, fileId, title }: { leadId: string; fileId: string; title: string }) {
  const [state, action, pending] = useActionState(removeLeadFileAction, IDLE_STATE);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="fileId" value={fileId} />
      <button type="submit" disabled={pending} aria-label={`Remove ${title}`} className="text-xs text-muted underline underline-offset-2 hover:text-danger">
        {pending ? 'Removing…' : 'Remove'}
      </button>
      <FormMessage status={state.status} message={state.status === 'error' ? state.message : undefined} />
    </form>
  );
}
