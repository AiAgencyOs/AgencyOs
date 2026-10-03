'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { addUnpricedMilestoneAction } from '@/modules/projects/milestone-create-actions';
import { buttonClass, FormMessage, inputClass, labelClass } from '@/ui';

/**
 * SCR-022 — "create a milestone on this day", in place. An UNPRICED
 * milestone through `projects.add_unpriced_milestone`: the payment plan's
 * 100% rule is untouched and nothing is billed for it; pricing stays on
 * the Plan tab.
 */
export function AddMilestoneOnDayForm({ projectId, dueOn, compact }: { projectId: string; dueOn: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(addUnpricedMilestoneAction, IDLE_STATE);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={compact ? 'text-xs text-muted hover:text-foreground' : buttonClass('ghost', 'sm')} aria-label={`Add a milestone due ${dueOn}`}>
        + milestone
      </button>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-canvas p-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Milestone</span>
        <input name="name" required maxLength={200} className={inputClass} autoFocus placeholder="Design sign-off" />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Due</span>
        <input name="dueOn" type="date" defaultValue={dueOn} className={inputClass} />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Adding…' : 'Add'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
        Cancel
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
