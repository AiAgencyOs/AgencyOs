'use client';

import { useActionState } from 'react';

import { acknowledgeEscalationAction, escalateBlockerAction, requestClientDependencyAction, startQaHandoffAction } from '@/modules/projects/development-events-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass } from '@/ui';

/**
 * SCR-039 — "Escalate blocker to PM" and "Start QA handoff" as RECORDS
 * (migration 20261001130000), mounted on the Development dashboard and on
 * the project's Development tab through these same components. The handoff
 * gate is the database's (`projects.start_qa_handoff`): a refusal names the
 * blocked and unfinished counts verbatim.
 */

export function EscalateBlockerPanel({ projectId, taskId, taskTitle }: { projectId: string; taskId: string; taskTitle: string }) {
  const [state, action, pending] = useActionState(escalateBlockerAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input name="reason" required maxLength={4000} className={inputClass} placeholder={`Why "${taskTitle}" needs the PM`} aria-label="Reason" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Escalating…' : 'Escalate to the PM'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function AcknowledgeEscalationButton({ projectId, eventId }: { projectId: string; eventId: string }) {
  const [state, action, pending] = useActionState(acknowledgeEscalationAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="eventId" value={eventId} />
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? 'Acknowledging…' : 'Acknowledge'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function StartQaHandoffPanel({ projectId, blocked, notReady }: { projectId: string; blocked: number; notReady: number }) {
  const [state, action, pending] = useActionState(startQaHandoffAction, IDLE_STATE);
  const gateOpen = blocked === 0 && notReady === 0;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className={buttonClass(gateOpen ? 'primary' : 'secondary', 'sm')} title={gateOpen ? 'Every task is in review or done' : `${blocked} blocked, ${notReady} not yet in review`}>
        {pending ? 'Starting…' : 'Start QA handoff'}
      </button>
      {!gateOpen ? (
        <span className="text-xs text-warning">
          gate: {blocked} blocked · {notReady} not yet in review
        </span>
      ) : null}
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** SCR-040 — ask the PM to request an outstanding client dependency from the client. Recorded; the plan row is not edited. */
export function RequestClientDependencyForm({ projectId, dependencyId }: { projectId: string; dependencyId: string }) {
  const [state, action, pending] = useActionState(requestClientDependencyAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="dependencyId" value={dependencyId} />
      <input name="note" maxLength={4000} className={inputClass} placeholder="Why it is needed now (optional)" aria-label="Why this client dependency is needed now" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Asking…' : 'Ask the PM to request it'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
