'use client';

import { useActionState } from 'react';

import { setDeliveryLeadAction, setMilestoneDueOnAction } from '@/modules/projects/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, selectClass } from '@/ui';

/** SCR-020 — set or clear one payment milestone's due date. */
export function MilestoneDueForm({ projectId, milestoneId, dueOn }: { projectId: string; milestoneId: string; dueOn: string | null }) {
  const [state, action, pending] = useActionState(setMilestoneDueOnAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <input type="date" name="dueOn" defaultValue={dueOn ?? ''} aria-label="Due date" className={`${inputClass} w-40`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : dueOn ? 'Change' : 'Set date'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** SCR-025 — who leads delivery, from the agency roster. */
export function DeliveryLeadForm({
  projectId,
  current,
  roster,
}: {
  projectId: string;
  current: string | null;
  roster: readonly { userId: string; fullName: string; role: string }[];
}) {
  const [state, action, pending] = useActionState(setDeliveryLeadAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2" key={current ?? 'none'}>
      <input type="hidden" name="projectId" value={projectId} />
      <select name="deliveryLeadId" defaultValue={current ?? ''} aria-label="Delivery lead" className={`${selectClass} w-auto min-w-48`}>
        <option value="">Nobody yet</option>
        {roster.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.fullName} · {m.role.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Assign'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
