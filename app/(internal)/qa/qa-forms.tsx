'use client';

import { useActionState, useState } from 'react';

import { assignRetestAction } from '@/modules/qa/retest-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, selectClass } from '@/ui';

import { HoldReleaseForm } from '../projects/[projectId]/release/release-hold-panel';

/**
 * SCR-044's two dashboard doors, mounted where the PDF puts them.
 *
 * `AssignRetestForm` — `qa.assign_retest`, the same door the project's QA
 * page uses; drawn per defect in the retest queue with the roster.
 * `BlockReleaseFromDashboard` — picks a project and renders the Release
 * tab's own `HoldReleaseForm` (SCR-044's hold door), so there is one
 * implementation and one door.
 */
export function AssignRetestForm({
  projectId,
  defectId,
  roster,
  currentAssigneeId,
}: {
  projectId: string;
  defectId: string;
  roster: { userId: string; fullName: string }[];
  currentAssigneeId: string | null;
}) {
  const [state, action, pending] = useActionState(assignRetestAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="defectId" value={defectId} />
      <select name="retesterId" required defaultValue={currentAssigneeId ?? ''} aria-label="Who verifies the fix" className={`${selectClass} h-8 w-44 text-xs`}>
        <option value="" disabled>
          Who retests?
        </option>
        {roster.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.fullName}
          </option>
        ))}
      </select>
      <input name="note" maxLength={600} placeholder="Note (optional)" aria-label="Note" className={`${inputClass} h-8 w-40 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Assigning…' : 'Assign retest'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function BlockReleaseFromDashboard({ projects }: { projects: { id: string; name: string; held: boolean }[] }) {
  const [projectId, setProjectId] = useState<string>('');
  const chosen = projects.find((p) => p.id === projectId) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project to hold" className={selectClass}>
        <option value="">Choose a project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id} disabled={p.held}>
            {p.name}
            {p.held ? ' — already held' : ''}
          </option>
        ))}
      </select>
      {chosen && !chosen.held ? <HoldReleaseForm projectId={chosen.id} /> : null}
    </div>
  );
}
