'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { raiseClarificationAction, submitChangeRequestAction } from '@/modules/projects/actions';
import type { RequirementsProjectPlan } from '@/modules/projects/requirements-recent-queries';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * SCR-028 — "Request clarification" and "Create change request" from the
 * Requirements dashboard. The SAME doors the Plan and Scope pages use
 * (`raiseClarificationAction` → `raise_plan_clarification`,
 * `submitChangeRequestAction` → `submit_change_request`), with a project
 * picker in front: a question is raised on the project's live plan, a
 * change request against its active baseline. A project without a plan
 * or a baseline is disabled in the picker with the reason, because the
 * door would refuse it.
 */
export function RequirementsDoors({ projects }: { projects: RequirementsProjectPlan[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ClarificationDoor projects={projects} />
      <ChangeRequestDoor projects={projects} />
    </div>
  );
}

function ClarificationDoor({ projects }: { projects: RequirementsProjectPlan[] }) {
  const [projectId, setProjectId] = useState('');
  const [state, action, pending] = useActionState(raiseClarificationAction, IDLE_STATE);
  const picked = projects.find((p) => p.projectId === projectId) ?? null;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <p className="text-[13px] font-semibold">Request clarification</p>
      <p className="text-xs text-muted">A question raised on the project’s plan — asked, not guessed. Somebody answers it on the Plan tab and the plan cannot activate until they do.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={picked?.planId ?? ''} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Project</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required className={selectClass}>
          <option value="" disabled>
            Pick a project
          </option>
          {projects.map((p) => (
            <option key={p.projectId} value={p.projectId} disabled={!p.planId}>
              {p.projectName}
              {!p.planId ? ' — no plan yet' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>The question</span>
        <input name="question" required maxLength={2000} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>What it affects if the answer goes either way</span>
        <input name="impact" required maxLength={2000} className={inputClass} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || !picked?.planId} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Raising…' : 'Raise a question'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function ChangeRequestDoor({ projects }: { projects: RequirementsProjectPlan[] }) {
  const [projectId, setProjectId] = useState('');
  const [state, action, pending] = useActionState(submitChangeRequestAction, IDLE_STATE);
  const picked = projects.find((p) => p.projectId === projectId) ?? null;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <p className="text-[13px] font-semibold">Create change request</p>
      <p className="text-xs text-muted">Against the project’s active scope baseline. Classify, decide and apply it on the Scope tab.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Project</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required className={selectClass}>
          <option value="" disabled>
            Pick a project
          </option>
          {projects.map((p) => (
            <option key={p.projectId} value={p.projectId} disabled={!p.hasActiveScope}>
              {p.projectName}
              {!p.hasActiveScope ? ' — no frozen baseline yet' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>What was asked for, in their own words</span>
        <textarea name="requested" required maxLength={4000} rows={2} className={textareaClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Source</span>
        <select name="source" defaultValue="internal" className={selectClass}>
          <option value="internal">Internal — raised by staff</option>
          <option value="client">Client — raised on the client’s behalf</option>
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || !picked?.hasActiveScope} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Submitting…' : 'Submit a change request'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
