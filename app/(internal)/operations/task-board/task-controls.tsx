'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { pauseTaskAction, resumeTaskAction, retryTaskAction, reassignTaskAction, reconcileTaskAction } from './actions';

/**
 * The controls on one task. Each shows only when its door could accept it (the database still decides under its own lock), and each needs a reason because the
 * reason is what the audit row keeps: a pause nobody explained is a task that stopped.
 */
export function TaskControls({ handoffId, boardState, paused, uncertain, toAgent }: { handoffId: string; boardState: string; paused: boolean; uncertain: boolean; toAgent: string }) {
  const [pauseState, pause, pausing] = useActionState(pauseTaskAction, IDLE_STATE);
  const [resumeState, resume, resuming] = useActionState(resumeTaskAction, IDLE_STATE);
  const [retryState, retry, retrying] = useActionState(retryTaskAction, IDLE_STATE);
  const [reassignState, reassign, reassigning] = useActionState(reassignTaskAction, IDLE_STATE);
  const [reconcileState, reconcile, reconciling] = useActionState(reconcileTaskAction, IDLE_STATE);

  if (boardState === 'closed') return <span className="text-xs text-muted">Settled</span>;

  return (
    <div className="flex flex-col gap-2">
      {paused ? (
        <form action={resume} className="flex items-center gap-2">
          <input type="hidden" name="handoffId" value={handoffId} />
          <button type="submit" disabled={resuming} className={buttonClass('secondary', 'sm')}>{resuming ? 'Resuming…' : 'Resume'}</button>
          <FormMessage status={resumeState.status} message={resumeState.message} className="text-xs" />
        </form>
      ) : (
        <form action={pause} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="handoffId" value={handoffId} />
          <input name="reason" required maxLength={500} placeholder="why pause" aria-label="Reason for pausing" className={`${inputClass} h-7 w-40 text-xs`} />
          <button type="submit" disabled={pausing} className={buttonClass('secondary', 'sm')}>{pausing ? 'Pausing…' : 'Pause'}</button>
          <FormMessage status={pauseState.status} message={pauseState.message} className="text-xs" />
        </form>
      )}

      {boardState === 'retrying' && uncertain ? (
        <form action={reconcile} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="handoffId" value={handoffId} />
          <select name="effect" aria-label="Did the effect happen" className={`${inputClass} h-7 text-xs`}>
            <option value="did_not_happen">It did not happen</option>
            <option value="happened">It happened</option>
          </select>
          <input name="note" required maxLength={500} placeholder="what you checked" aria-label="What you checked" className={`${inputClass} h-7 w-44 text-xs`} />
          <button type="submit" disabled={reconciling} className={buttonClass('secondary', 'sm')}>{reconciling ? 'Saving…' : 'Reconcile'}</button>
          <FormMessage status={reconcileState.status} message={reconcileState.message} className="text-xs" />
        </form>
      ) : null}

      {boardState === 'retrying' ? (
        <form action={retry} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="handoffId" value={handoffId} />
          <input name="reason" required maxLength={500} placeholder="why retry" aria-label="Reason for retrying" className={`${inputClass} h-7 w-40 text-xs`} />
          <button type="submit" disabled={retrying} className={buttonClass('primary', 'sm')}>{retrying ? 'Retrying…' : 'Retry'}</button>
          <FormMessage status={retryState.status} message={retryState.message} className="text-xs" />
        </form>
      ) : null}

      {boardState === 'created' ? (
        <form action={reassign} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="handoffId" value={handoffId} />
          <input name="toAgent" required maxLength={80} defaultValue={toAgent} aria-label="Agent to hand it to" className={`${inputClass} h-7 w-36 text-xs`} />
          <input name="reason" required maxLength={500} placeholder="why reassign" aria-label="Reason for reassigning" className={`${inputClass} h-7 w-40 text-xs`} />
          <button type="submit" disabled={reassigning} className={buttonClass('secondary', 'sm')}>{reassigning ? 'Saving…' : 'Reassign'}</button>
          <FormMessage status={reassignState.status} message={reassignState.message} className="text-xs" />
        </form>
      ) : null}
    </div>
  );
}
