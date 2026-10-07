'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import {
  decidePmTemplateAction,
  discardPmTemplateDraftAction,
  savePmTemplateDraftAction,
  submitPmTemplateAction,
  withdrawPmTemplateAction,
} from '@/modules/projects/pm-template-actions';
import { buttonClass, FormMessage, inputClass, labelClass } from '@/ui';

export function DraftEditor({ templateKey, language, initial, hasDraft }: { templateKey: string; language: string; initial: string; hasDraft: boolean }) {
  const [state, action, pending] = useActionState(savePmTemplateDraftAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="key" value={templateKey} />
      <input type="hidden" name="language" value={language} />
      <label htmlFor={id} className={labelClass}>
        {hasDraft ? 'Edit the draft' : 'Write a new version (starts from the wording in use)'}
      </label>
      <textarea id={id} name="body" required rows={5} maxLength={1500} defaultValue={initial} className={`${inputClass} h-auto py-2`} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : hasDraft ? 'Save draft' : 'Save as a draft'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function VersionActions({ id, status }: { id: string; status: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'superseded' }) {
  const [submitState, submit, submitting] = useActionState(submitPmTemplateAction, IDLE_STATE);
  const [withdrawState, withdraw, withdrawing] = useActionState(withdrawPmTemplateAction, IDLE_STATE);
  const [discardState, discard, discarding] = useActionState(discardPmTemplateDraftAction, IDLE_STATE);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {status === 'draft' ? (
        <>
          <form action={submit}>
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={submitting} className={buttonClass('primary', 'sm')}>{submitting ? 'Submitting…' : 'Submit for review'}</button>
          </form>
          <form action={discard}>
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={discarding} className={buttonClass('secondary', 'sm')}>{discarding ? 'Discarding…' : 'Discard draft'}</button>
          </form>
        </>
      ) : null}
      {status === 'pending_review' ? (
        <form action={withdraw}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" disabled={withdrawing} className={buttonClass('secondary', 'sm')}>{withdrawing ? 'Withdrawing…' : 'Take it back to draft'}</button>
        </form>
      ) : null}
      <FormMessage status={submitState.status} message={submitState.message} />
      <FormMessage status={withdrawState.status} message={withdrawState.message} />
      <FormMessage status={discardState.status} message={discardState.message} />
    </div>
  );
}

export function DecisionForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(decidePmTemplateAction, IDLE_STATE);
  const noteId = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2">
      <input type="hidden" name="id" value={id} />
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label htmlFor={noteId} className={labelClass}>
          Note (required to reject)
        </label>
        <input id={noteId} name="note" maxLength={500} className={inputClass} />
      </div>
      <button type="submit" name="decision" value="approve" disabled={pending} className={buttonClass('primary', 'sm')}>
        Approve: make it live
      </button>
      <button type="submit" name="decision" value="reject" disabled={pending} className={buttonClass('secondary', 'sm')}>
        Reject
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
