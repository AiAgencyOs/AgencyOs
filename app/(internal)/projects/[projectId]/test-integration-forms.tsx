'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { requestDocumentationDraftAction, requestTestCaseDraftsAction } from '@/modules/projects/test-integration-actions';
import { buttonClass } from '@/ui';

/** Asking an agent is queueing a job; the agent only drafts, and a person decides what the draft becomes. The database and the runner refuse anything else. */

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

export function RequestDocumentationDraftForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(requestDocumentationDraftAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Ask the Documentation agent for a draft. It documents only what the records show and is never marked implemented.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Asking…' : 'Draft documentation'}</button>
      <Message state={state} />
    </form>
  );
}

export function RequestTestCaseDraftsForm({ projectId, tasks }: { projectId: string; tasks: { id: string; title: string }[] }) {
  const [state, action, pending] = useActionState(requestTestCaseDraftsAction, IDLE_STATE);
  if (tasks.length === 0) return null;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Ask the Test Automation agent to propose test cases for a task. A proposal is not a test, a run or a result.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <select aria-label="Task" name="taskId" className="rounded-md border border-line bg-surface px-2 py-1">
        {tasks.map((t) => (
          <option key={t.id} value={t.id}>{t.title}</option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Asking…' : 'Propose test cases'}</button>
      <Message state={state} />
    </form>
  );
}
