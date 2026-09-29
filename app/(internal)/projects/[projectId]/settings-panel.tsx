'use client';

import { useActionState } from 'react';

import { setProjectVisibilityAction, updateProjectAction } from '@/modules/projects/actions';
import { PROJECT_VISIBILITIES } from '@/modules/projects/schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { Card, FormMessage, buttonClass, humanize, selectClass, inputClass, labelClass, textareaClass } from '@/ui';

/**
 * SCR-027's Settings half — the client-portal visibility switch
 * (`projects.projects.visibility`), which has gated `projects_select` and
 * `milestones_select` for the client role since the schema's first
 * migration and had no admin control anywhere until now.
 */
export function ProjectVisibilityForm({ projectId, current }: { projectId: string; current: string }) {
  const [state, action, pending] = useActionState(setProjectVisibilityAction, IDLE_STATE);

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="pv-visibility" className="text-[13px] font-medium text-foreground">
            Client portal visibility
          </label>
          <select id="pv-visibility" name="visibility" defaultValue={current} className={`${selectClass} w-auto`}>
            {PROJECT_VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {humanize(v)}
              </option>
            ))}
          </select>
          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
        <p className="text-xs text-muted">
          "Client" shows this project, its milestones and its client-visible deliverables in the
          client's own portal. "Internal" hides it entirely — the client portal's RLS refuses the
          rows outright, not just the link to them.
        </p>
        <FormMessage status={state.status} message={state.message} />
      </form>
    </Card>
  );
}

/** The project's own facts — what the header prints. Status, visibility and billing keep their own doors. */
export function ProjectDetailsForm({
  projectId,
  name,
  description,
  startsOn,
  endsOn,
  budgetMinor,
  currency,
}: {
  projectId: string;
  name: string;
  description: string | null;
  startsOn: string | null;
  endsOn: string | null;
  budgetMinor: number | null;
  currency: string;
}) {
  const [state, action, pending] = useActionState(updateProjectAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor="project-name" className={labelClass}>Project name</label>
        <input id="project-name" name="name" required maxLength={200} defaultValue={name} className={inputClass} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="project-description" className={labelClass}>Description</label>
        <textarea id="project-description" name="description" rows={3} maxLength={4000} defaultValue={description ?? ''} className={textareaClass} placeholder="One line the header shows under the name" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="project-starts" className={labelClass}>Start date</label>
          <input id="project-starts" name="startsOn" type="date" defaultValue={startsOn ?? ''} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="project-ends" className={labelClass}>Due date</label>
          <input id="project-ends" name="endsOn" type="date" defaultValue={endsOn ?? ''} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="project-budget" className={labelClass}>Budget ({currency})</label>
          <input id="project-budget" name="budget" type="number" min="0" step="0.01" defaultValue={budgetMinor === null ? '' : String(budgetMinor / 100)} className={inputClass} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save project'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
