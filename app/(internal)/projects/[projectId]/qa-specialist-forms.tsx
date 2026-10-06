'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { decideQaFindingAction, requestQaSpecialistAction } from '@/modules/projects/qa-specialist-actions';
import { buttonClass } from '@/ui';

/** Forms for the QA specialist panel. They decide nothing: the database doors refuse (independence, commit, evidence) and the refusal is shown as written. */

const field = 'rounded-md border border-line bg-surface px-2 py-1';

function Status({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

export function AskQaSpecialistForm({ projectId, jobs, candidate }: { projectId: string; jobs: { id: string; label: string }[]; candidate: { id: string; label: string } | null }) {
  const [state, action, pending] = useActionState(requestQaSpecialistAction, IDLE_STATE);
  const options = [...jobs.map((j) => ({ name: 'jobId', ...j })), ...(candidate ? [{ name: 'candidateId', ...candidate }] : [])];
  if (options.length === 0) return <p className="text-[13px] text-muted">No QA job is scheduled yet, so there is nothing to ask a specialist about.</p>;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <p className="text-[13px] text-muted">The specialist only proposes. You asked, so a different person has to accept what it proposes.</p>
      <select aria-label="What to ask about" name="subject" className={field} defaultValue={`${options[0]!.name}:${options[0]!.id}`}>
        {options.map((o) => (
          <option key={`${o.name}:${o.id}`} value={`${o.name}:${o.id}`}>{o.label}</option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Asking…' : 'Ask the QA specialist'}</button>
      <Status state={state} />
    </form>
  );
}

export function DecideQaFindingForm({ projectId, findingId, canAccept }: { projectId: string; findingId: string; canAccept: boolean }) {
  const [state, action, pending] = useActionState(decideQaFindingAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="findingId" value={findingId} />
      <input aria-label="Note (required to reject)" name="note" placeholder="Note (required to reject)" className={field} />
      <div className="flex gap-2">
        <button type="submit" name="decision" value="accept" disabled={pending || !canAccept} className={buttonClass('secondary', 'sm')}>Accept as the result</button>
        <button type="submit" name="decision" value="reject" disabled={pending || !canAccept} className={buttonClass('secondary', 'sm')}>Reject</button>
      </div>
      {!canAccept ? <p className="text-[13px] text-muted">You asked for this run, so someone else decides.</p> : null}
      <Status state={state} />
    </form>
  );
}
