'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { setMemberDepartmentAction } from '@/modules/projects/member-department-actions';
import { DEPARTMENTS } from '@/modules/projects/member-department-schema';
import { selectClass } from '@/ui';

/** A member's department, from the fixed list — saved when it changes (core.set_member_department). */
export function DepartmentSelect({ projectId, userId, name, current }: { projectId: string; userId: string; name: string; current: string | null }) {
  const [state, action, pending] = useActionState(setMemberDepartmentAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="inline-flex flex-col gap-0.5" key={current ?? 'none'}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="userId" value={userId} />
      <label htmlFor={id} className="sr-only">Department of {name}</label>
      <select id={id} name="department" defaultValue={current ?? ''} disabled={pending} onChange={(e) => e.currentTarget.form?.requestSubmit()} className={`${selectClass} min-w-[9.5rem]`}>
        <option value="">No department</option>
        {DEPARTMENTS.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
