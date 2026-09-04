'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

import {
  commitRecordAction,
  enrolBatchAction,
  uploadImportAction,
  withdrawBatchAction,
} from './actions';

function Message({ status, message }: { status: string; message?: string }) {
  if (status === 'idle' || !message) return null;
  return (
    <span className={`text-xs ${status === 'error' ? 'text-danger' : 'text-success'}`}>
      {message}
    </span>
  );
}

export function UploadForm() {
  const [state, action, pending] = useActionState(uploadImportAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input
        type="file"
        name="file"
        accept=".txt,text/plain"
        required
        aria-label="WhatsApp export file"
        className="w-full text-[13px] text-muted file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-foreground hover:file:bg-surface-hover"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className={buttonClass('secondary', 'sm')}
        >
          {pending ? 'Staging…' : 'Upload & stage'}
        </button>
        <Message status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function CommitButton({ recordId, batchId }: { recordId: string; batchId: string }) {
  const [state, action, pending] = useActionState(commitRecordAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="recordId" value={recordId} />
      <input type="hidden" name="batchId" value={batchId} />
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Committing…' : 'Commit'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

/**
 * Enrol, or take back out, a whole batch — G-219.
 *
 * Two buttons and a sentence, because the sentence is the important part: an
 * operator pressing this is deciding to start a campaign against everybody in
 * the file who is eligible, and the count of who that turns out to be is not
 * knowable until it runs.
 */
export function BatchCohortButtons({ batchId }: { batchId: string }) {
  const [enrolState, enrolAction, enrolPending] = useActionState(enrolBatchAction, IDLE_STATE);
  const [outState, outAction, outPending] = useActionState(withdrawBatchAction, IDLE_STATE);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={enrolAction}>
          <input type="hidden" name="batch_id" value={batchId} />
          <button type="submit" disabled={enrolPending} className={buttonClass('secondary', 'sm')}>
            {enrolPending ? 'Enrolling…' : 'Enrol everyone eligible'}
          </button>
        </form>
        <form action={outAction}>
          <input type="hidden" name="batch_id" value={batchId} />
          <button type="submit" disabled={outPending} className={buttonClass('ghost', 'sm')}>
            {outPending ? 'Removing…' : 'Take this batch back out'}
          </button>
        </form>
      </div>
      <p className="text-xs text-muted">
        Up to 500 at a time, so you can watch what happens. Anyone who never wrote to you, and anyone
        who is already a client or a live deal, is left out — and enrolling somebody sends them
        nothing on its own.
      </p>
      <Message status={enrolState.status} message={enrolState.message} />
      <Message status={outState.status} message={outState.message} />
    </div>
  );
}
