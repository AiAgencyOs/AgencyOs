'use client';

import { useActionState } from 'react';

import { setProjectVisibilityAction, updateProjectAction } from '@/modules/projects/actions';
import { setProjectClassificationAction } from '@/modules/projects/project-classification-actions';
import { CHIP_MAX_LENGTH, PROJECT_TYPES, TAGS_MAX, TECHNOLOGY_MAX } from '@/modules/projects/project-classification-schema';
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

/**
 * Owner decision 4: what kind of project this is (a fixed list) and its
 * technology and tags (free-text chips). Its own door, projects.
 * set_project_classification — separate from the details above, so saving one
 * never rewrites the other.
 */
export function ProjectClassificationForm({ projectId, type, technology, tags }: { projectId: string; type: string | null; technology: string[]; tags: string[] }) {
  const [state, action, pending] = useActionState(setProjectClassificationAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="project-type" className={labelClass}>Project type</label>
          <select id="project-type" name="type" defaultValue={type ?? ''} className={selectClass}>
            <option value="">Not set</option>
            {PROJECT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="project-technology" className={labelClass}>Technology</label>
          <input id="project-technology" name="technology" defaultValue={technology.join(', ')} maxLength={400} placeholder="react, node.js, postgres" className={inputClass} />
          <p className="text-[11px] text-muted">Up to {TECHNOLOGY_MAX}, separated by commas; lower-case, each up to {CHIP_MAX_LENGTH} characters.</p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="project-tags" className={labelClass}>Tags</label>
          <input id="project-tags" name="tags" defaultValue={tags.join(', ')} maxLength={400} placeholder="ott, streaming, ai" className={inputClass} />
          <p className="text-[11px] text-muted">Up to {TAGS_MAX}, separated by commas.</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save type and tags'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
