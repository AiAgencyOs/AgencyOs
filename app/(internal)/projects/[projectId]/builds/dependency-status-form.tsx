'use client';

import { useActionState } from 'react';

import { setDependencyStatusAction } from '@/modules/projects/dependency-status-actions';
import type { DependencyStatus } from '@/modules/projects/dependency-status-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass } from '@/ui';

/**
 * SCR-043 — mark a technical dependency supplied or waived, or reopen it.
 * One form per target status so a row shows exactly the moves that apply;
 * `projects.set_dependency_status` decides again and refuses `unchanged`.
 */
export function DependencyStatusForm({ projectId, dependencyId, current }: { projectId: string; dependencyId: string; current: DependencyStatus }) {
  const [state, action, pending] = useActionState(setDependencyStatusAction, IDLE_STATE);
  const moves: { status: DependencyStatus; label: string }[] =
    current === 'open'
      ? [
          { status: 'supplied', label: 'Mark supplied' },
          { status: 'waived', label: 'Waive' },
        ]
      : [{ status: 'open', label: 'Reopen' }];

  return (
    <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="dependencyId" value={dependencyId} />
      <input name="note" maxLength={1000} className={`${inputClass} w-auto min-w-48 flex-1`} placeholder={current === 'open' ? 'Note (optional) — where it came from, why it is not needed' : 'Why it is open again (optional)'} />
      {moves.map((m) => (
        <button key={m.status} type="submit" name="status" value={m.status} disabled={pending} className={buttonClass(m.status === 'supplied' ? 'primary' : 'secondary', 'sm')}>
          {pending ? 'Saving…' : m.label}
        </button>
      ))}
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
