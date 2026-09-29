'use client';

import { useActionState } from 'react';

import { linkMeetingProjectAction } from '@/modules/crm/meeting-project-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, cx, FormMessage, selectClass } from '@/ui';

/**
 * SCR-010 — link the meeting to a project (`crm.meetings.project_id`).
 * The lead's own projects first, then the rest the reader can see; an
 * empty choice removes the link. The door re-checks `lead.write`, RLS
 * decides again, and the change is audited.
 */
export function MeetingProjectForm({
  meetingId,
  current,
  leadProjects,
  otherProjects,
}: {
  meetingId: string;
  current: string | null;
  leadProjects: readonly { id: string; name: string }[];
  otherProjects: readonly { id: string; name: string; status: string }[];
}) {
  const [state, action, pending] = useActionState(linkMeetingProjectAction, IDLE_STATE);
  const leadIds = new Set(leadProjects.map((p) => p.id));
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <select name="projectId" defaultValue={current ?? ''} aria-label="Project" className={cx(selectClass, 'w-auto max-w-xs')}>
        <option value="">No project</option>
        {leadProjects.length > 0 ? (
          <optgroup label="This lead's projects">
            {leadProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label="Other projects">
          {otherProjects
            .filter((p) => !leadIds.has(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.status.replace(/_/g, ' ')}
              </option>
            ))}
        </optgroup>
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Link'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
