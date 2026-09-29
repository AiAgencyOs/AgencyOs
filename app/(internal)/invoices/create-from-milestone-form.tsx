'use client';

import { useActionState, useState } from 'react';

import { generateMilestoneInvoiceAction } from '@/modules/finance/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

export type EligibleMilestone = {
  id: string;
  projectId: string;
  name: string;
  position: number;
  amountLabel: string;
};

/**
 * Raise a draft invoice from an eligible milestone, from the invoice list —
 * SCR-051. Same door the project page's per-row button uses
 * (`generateMilestoneInvoiceAction` → `generateInvoiceFromMilestone`): the
 * service decides whether the milestone may be billed and answers with the
 * existing invoice on a repeat, so this form adds no rule of its own. The
 * picker only offers milestones the shared eligibility rule already cleared
 * and that carry no invoice yet; anything else stays on its project page
 * where the reason it cannot be billed is written next to it.
 */
export function CreateFromMilestoneForm({
  projects,
  milestones,
}: {
  projects: { id: string; name: string }[];
  milestones: EligibleMilestone[];
}) {
  const [state, action, pending] = useActionState(generateMilestoneInvoiceAction, IDLE_STATE);
  const [projectId, setProjectId] = useState('');

  const offered = milestones.filter((m) => m.projectId === projectId);
  const projectsWithMilestones = projects.filter((p) => milestones.some((m) => m.projectId === p.id));

  if (projectsWithMilestones.length === 0) {
    return <p className="text-[13px] text-muted">No milestone is clear to invoice right now.</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap gap-3">
        <div className="flex min-w-48 flex-col gap-1">
          <label className={labelClass} htmlFor="milestone-project">
            Project
          </label>
          <select
            id="milestone-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={selectClass}
          >
            <option value="">Choose a project…</option>
            {projectsWithMilestones.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-56 flex-col gap-1">
          <label className={labelClass} htmlFor="milestone-id">
            Milestone
          </label>
          <select id="milestone-id" name="milestoneId" required defaultValue="" disabled={!projectId} className={selectClass}>
            <option value="" disabled>
              {projectId ? 'Which milestone?' : 'Pick a project first'}
            </option>
            {offered.map((m) => (
              <option key={m.id} value={m.id}>
                {m.position}. {m.name} · {m.amountLabel}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="milestone-due">
            Due in (days)
          </label>
          <input id="milestone-due" name="dueInDays" inputMode="numeric" placeholder="default" className={`${inputClass} w-28`} />
        </div>
      </div>
      <button type="submit" disabled={pending || !projectId} className={`${buttonClass('primary', 'sm')} self-start`}>
        {pending ? 'Drafting…' : 'Create draft invoice'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
