'use client';

import { useActionState, useId, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { raiseClarificationAction, submitChangeRequestAction } from '@/modules/projects/actions';
import { raiseRequirementClarificationAction } from '@/modules/projects/requirement-clarifications-actions';
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
export function RequirementsDoors({ projects, mayAskClarification, mayRaise }: { projects: RequirementsProjectPlan[]; mayAskClarification: boolean; mayRaise: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {mayAskClarification ? <RequirementClarificationDoor projects={projects} /> : null}
      {mayRaise ? <ClarificationDoor projects={projects} /> : null}
      {mayRaise ? <ChangeRequestDoor projects={projects} /> : null}
    </div>
  );
}

/**
 * "Request clarification" on a requirement (SCR-028): the question is written
 * against one requirement of the project's scope, so it reaches that
 * requirement — it shows on the requirement, in the open-question queue and in
 * the open-clarification counts — and needs no plan.
 */
function RequirementClarificationDoor({ projects }: { projects: RequirementsProjectPlan[] }) {
  const [projectId, setProjectId] = useState('');
  const [state, action, pending] = useActionState(raiseRequirementClarificationAction, IDLE_STATE);
  const projectSelectId = useId();
  const itemSelectId = useId();
  const questionId = useId();
  const impactId = useId();
  const picked = projects.find((p) => p.projectId === projectId) ?? null;
  return (
    <form action={action} key={state.status === 'success' ? 'asked' : 'ask'} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <p className="text-[13px] font-semibold">Request clarification</p>
      <p className="text-xs text-muted">A question about one requirement, asked of the client. It stays on the requirement and in the open-question queue until somebody records the answer.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <label htmlFor={projectSelectId} className={labelClass}>Project</label>
      <select id={projectSelectId} value={projectId} onChange={(e) => setProjectId(e.target.value)} required className={selectClass}>
        <option value="" disabled>
          Pick a project
        </option>
        {projects.map((p) => (
          <option key={p.projectId} value={p.projectId} disabled={p.requirements.length === 0}>
            {p.projectName}
            {p.requirements.length === 0 ? ' — no requirements yet' : ''}
          </option>
        ))}
      </select>
      <label htmlFor={itemSelectId} className={labelClass}>Requirement</label>
      <select id={itemSelectId} name="scopeItemId" required disabled={!picked} defaultValue="" className={selectClass} key={projectId}>
        <option value="" disabled>
          Pick a requirement
        </option>
        {(picked?.requirements ?? []).map((r) => (
          <option key={r.id} value={r.id}>
            {r.title}
          </option>
        ))}
      </select>
      <label htmlFor={questionId} className={labelClass}>The question for the client</label>
      <input id={questionId} name="question" required maxLength={1000} className={inputClass} />
      <label htmlFor={impactId} className={labelClass}>What it changes if the answer goes either way</label>
      <input id={impactId} name="impact" required maxLength={1000} className={inputClass} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || !picked} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Requesting…' : 'Request Clarification'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function ClarificationDoor({ projects }: { projects: RequirementsProjectPlan[] }) {
  const [projectId, setProjectId] = useState('');
  const [state, action, pending] = useActionState(raiseClarificationAction, IDLE_STATE);
  const picked = projects.find((p) => p.projectId === projectId) ?? null;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <p className="text-[13px] font-semibold">Raise a plan question</p>
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
