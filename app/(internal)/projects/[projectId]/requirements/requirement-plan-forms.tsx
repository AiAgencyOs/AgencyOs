'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { linkRequirementFileAction, setRequirementPlanAction, unlinkRequirementFileAction } from '@/modules/projects/requirement-plan-actions';
import { PRIORITY_LABEL, REQUIREMENT_PRIORITIES } from '@/modules/projects/requirement-plan-schema';
import { buttonClass, FormMessage, labelClass, selectClass } from '@/ui';

/**
 * Priority and assignee — editable after the scope is frozen, because they are
 * kept beside the frozen row (projects.set_requirement_plan), never in it.
 */
export function RequirementPlanForm({ projectId, scopeItemId, priority, assigneeId, roster }: { projectId: string; scopeItemId: string; priority: string | null; assigneeId: string | null; roster: { userId: string; fullName: string }[] }) {
  const [state, action, pending] = useActionState(setRequirementPlanAction, IDLE_STATE);
  const priorityId = useId();
  const assigneeFieldId = useId();
  return (
    <form action={action} key={`${scopeItemId}-${priority}-${assigneeId}`} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="scopeItemId" value={scopeItemId} />
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={priorityId} className={labelClass}>Priority</label>
          <select id={priorityId} name="priority" defaultValue={priority ?? ''} className={selectClass}>
            <option value="">Not set</option>
            {REQUIREMENT_PRIORITIES.map((p) => (
              <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={assigneeFieldId} className={labelClass}>Assignee</label>
          <select id={assigneeFieldId} name="assigneeId" defaultValue={assigneeId ?? ''} className={selectClass}>
            <option value="">Unassigned</option>
            {roster.map((p) => (
              <option key={p.userId} value={p.userId}>{p.fullName}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Save'}</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/** Attach one of the project's existing files (a link — nothing is uploaded here). */
export function AttachFileForm({ projectId, scopeItemId, choices }: { projectId: string; scopeItemId: string; choices: { id: string; title: string }[] }) {
  const [state, action, pending] = useActionState(linkRequirementFileAction, IDLE_STATE);
  const id = useId();
  if (choices.length === 0) return <p className="text-xs text-muted">Every file of the project is already attached, or the project has no file yet.</p>;
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="scopeItemId" value={scopeItemId} />
      <label htmlFor={id} className={labelClass}>Attach a project file</label>
      <div className="flex flex-wrap items-center gap-2">
        <select id={id} name="fileId" required defaultValue="" className={`${selectClass} min-w-0 flex-1`}>
          <option value="" disabled>Pick a file</option>
          {choices.map((f) => (
            <option key={f.id} value={f.id}>{f.title}</option>
          ))}
        </select>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Attaching…' : 'Attach'}</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function DetachFileButton({ projectId, scopeItemId, fileId, title }: { projectId: string; scopeItemId: string; fileId: string; title: string }) {
  const [state, action, pending] = useActionState(unlinkRequirementFileAction, IDLE_STATE);
  return (
    <form action={action} className="inline-flex items-center gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="scopeItemId" value={scopeItemId} />
      <input type="hidden" name="fileId" value={fileId} />
      <button type="submit" disabled={pending} aria-label={`Detach ${title}`} className="text-xs text-faint hover:text-danger">Detach</button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
