'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { requestSpecialistProposalAction } from '@/modules/projects/specialist-actions';
import { buttonClass } from '@/ui';

/** Asking a specialist is queueing a job; it only proposes, and the database and the runner refuse anything else. */
export function AskSpecialistForm({ projectId, taskId, agentLabel }: { projectId: string; taskId: string; agentLabel: string }) {
  const [state, action, pending] = useActionState(requestSpecialistProposalAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Asking…' : `Ask the ${agentLabel}`}</button>
      {state.status !== 'idle' && state.message ? (
        <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">{state.message}</p>
      ) : null}
    </form>
  );
}
