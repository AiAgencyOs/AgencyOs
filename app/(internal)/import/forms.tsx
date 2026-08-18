'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';

import { commitRecordAction, uploadImportAction } from './actions';

function Message({ status, message }: { status: string; message?: string }) {
  if (status === 'idle' || !message) return null;
  return (
    <span className={`text-xs ${status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
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
        className="text-sm file:mr-3 file:rounded file:border file:border-default file:bg-transparent file:px-2 file:py-1 file:text-xs file:font-medium"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-default px-3 py-1.5 text-sm font-medium hover:bg-subtle disabled:opacity-50"
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
        className="rounded border border-default px-2 py-1 text-xs font-medium hover:bg-subtle disabled:opacity-50"
      >
        {pending ? 'Committing…' : 'Commit'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}
