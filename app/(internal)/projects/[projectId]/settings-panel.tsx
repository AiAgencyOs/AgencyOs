'use client';

import { useActionState } from 'react';

import { setProjectVisibilityAction } from '@/modules/projects/actions';
import { PROJECT_VISIBILITIES } from '@/modules/projects/schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { Card, FormMessage, buttonClass, humanize, selectClass } from '@/ui';

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
