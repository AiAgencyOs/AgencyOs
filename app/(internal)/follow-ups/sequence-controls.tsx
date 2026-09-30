'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { resumeFollowUpSequenceAction, stopFollowUpSequenceAction } from '@/modules/crm/actions';
import { decideFollowUpSequenceAction } from '@/modules/crm/follow-up-decision-actions';
import { buttonClass, FormMessage, inputClass } from '@/ui';

/**
 * A person's controls over one sequence — SCR-013. Stop (pause) and Resume
 * are the module's older doors; Reschedule, Complete and Cancel go through
 * `crm.decide_follow_up_sequence`, which requires a reason for each and
 * audits it. Shared by the Follow-ups list and the Lead 360's sequences
 * card (bucket F rule 1): one component, one set of doors. The row's
 * status is re-read after the action, never assumed.
 */
type Mode = 'stop' | 'reschedule' | 'complete' | 'cancel';

export function SequenceControls({ sequenceId, status, leadId }: { sequenceId: string; status: string; leadId?: string | null }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [stopState, stopAction, stopping] = useActionState(stopFollowUpSequenceAction, IDLE_STATE);
  const [resumeState, resumeAction, resuming] = useActionState(resumeFollowUpSequenceAction, IDLE_STATE);
  const [decideState, decideAction, deciding] = useActionState(decideFollowUpSequenceAction, IDLE_STATE);

  const open = status === 'active' || status === 'escalated' || status === 'stopped';
  if (!open) return <span className="text-xs text-muted">—</span>;

  if (mode === null) {
    return (
      <span className="flex flex-wrap items-center justify-end gap-1">
        {status === 'stopped' ? (
          <form action={resumeAction} className="flex items-center gap-2">
            <input type="hidden" name="sequenceId" value={sequenceId} />
            <button type="submit" disabled={resuming} className={buttonClass('secondary', 'sm')}>
              {resuming ? 'Resuming…' : 'Resume'}
            </button>
            <FormMessage status={resumeState.status} message={resumeState.message} />
          </form>
        ) : null}
        {status === 'active' ? (
          <button type="button" onClick={() => setMode('stop')} className={buttonClass('ghost', 'sm')}>
            Stop
          </button>
        ) : null}
        <button type="button" onClick={() => setMode('reschedule')} className={buttonClass('ghost', 'sm')}>
          Reschedule
        </button>
        <button type="button" onClick={() => setMode('complete')} className={buttonClass('ghost', 'sm')}>
          Complete
        </button>
        <button type="button" onClick={() => setMode('cancel')} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
        <FormMessage status={decideState.status} message={decideState.message} />
      </span>
    );
  }

  if (mode === 'stop') {
    return (
      <form action={stopAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="sequenceId" value={sequenceId} />
        <input name="reason" required maxLength={200} placeholder="Why" aria-label="Why stop this sequence" className={`${inputClass} w-44`} />
        <button type="submit" disabled={stopping} className={buttonClass('danger', 'sm')}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
        <button type="button" onClick={() => setMode(null)} className={buttonClass('ghost', 'sm')}>
          Back
        </button>
        <FormMessage status={stopState.status} message={stopState.message} />
      </form>
    );
  }

  const label = mode === 'reschedule' ? 'Reschedule' : mode === 'complete' ? 'Mark complete' : 'Cancel sequence';
  return (
    <form action={decideAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="sequenceId" value={sequenceId} />
      <input type="hidden" name="action" value={mode} />
      {leadId ? <input type="hidden" name="leadId" value={leadId} /> : null}
      {mode === 'reschedule' ? (
        <input name="nextDueAt" type="datetime-local" required aria-label="New due time" className={`${inputClass} w-52`} />
      ) : null}
      <input name="reason" required maxLength={500} placeholder="Why (required)" aria-label={`Why ${mode} this sequence`} className={`${inputClass} w-48`} />
      <button type="submit" disabled={deciding} className={buttonClass(mode === 'cancel' ? 'danger' : 'primary', 'sm')}>
        {deciding ? 'Recording…' : label}
      </button>
      <button type="button" onClick={() => setMode(null)} className={buttonClass('ghost', 'sm')}>
        Back
      </button>
      <FormMessage status={decideState.status} message={decideState.message} />
    </form>
  );
}
