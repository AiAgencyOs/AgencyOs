'use client';

import { useActionState } from 'react';

import { attachMeetingSummaryToMemoryAction } from '@/modules/crm/meeting-memory-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, cx, FormMessage, selectClass } from '@/ui';

/**
 * SCR-017 — "Attach to project memory". Picks one of the projects the
 * meeting's lead reaches (through its client account) and hands the meeting
 * to `attachMeetingSummaryToMemory`. What is attached is the meeting's own
 * newest summary or typed notes — chosen by the door, never typed here.
 * Mounted on the meeting page and on Client 360's meeting notes.
 */
export function AttachMeetingSummaryForm({
  meetingId,
  projects,
  clientId,
  compact,
}: {
  meetingId: string;
  projects: { id: string; name: string }[];
  clientId?: string;
  compact?: boolean;
}) {
  const [state, action, pending] = useActionState(attachMeetingSummaryToMemoryAction, IDLE_STATE);

  if (projects.length === 0) {
    return <p className="text-[12px] text-muted">No project to attach to — this meeting’s lead has not become a client with a project yet.</p>;
  }

  return (
    <form action={action} className={cx('flex flex-col gap-1', compact ? '' : 'mt-1')}>
      <input type="hidden" name="meetingId" value={meetingId} />
      {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <select name="projectId" aria-label="Project" defaultValue={projects[0]?.id} className={cx(selectClass, 'h-8 w-auto max-w-[16rem] text-[13px]')}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Attaching…' : 'Attach to project memory'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
