'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

import { commitRecordAction, uploadImportAction } from './actions';

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
