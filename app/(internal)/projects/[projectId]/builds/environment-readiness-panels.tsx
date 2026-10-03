'use client';

import { useActionState, useId } from 'react';

import { promoteBuildAction, recordEnvironmentCheckAction } from '@/modules/projects/environment-readiness-actions';
import { READINESS_CHECK_LABEL, type ReadinessCheck } from '@/modules/projects/environment-readiness-schema';
import { CHECK_RUN_CHECKS, CHECK_RUN_CHECK_LABEL, DEFAULT_CHECKS_WORKFLOW } from '@/modules/projects/environment-check-runs';
import { dispatchEnvironmentChecksAction, refreshEnvironmentChecksAction, triggerBuildAction } from '@/modules/projects/git-write-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-043 — the Builds tab's doors (migration 20261001130000): record one
 * readiness check on an environment, promote a build (gated in the
 * database on the three checks and on qa.release_gates), and trigger a
 * build (a record, plus a GitHub Actions dispatch when a workflow file is
 * linked). Every refusal is shown verbatim.
 */

export function RecordCheckPanel({ projectId, environmentId, check }: { projectId: string; environmentId: string; check: ReadinessCheck }) {
  const [state, action, pending] = useActionState(recordEnvironmentCheckAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="environmentId" value={environmentId} />
      <input type="hidden" name="check" value={check} />
      <div className="flex flex-wrap items-center gap-1.5">
        <select name="ok" className={selectClass} defaultValue="true" aria-label={`${READINESS_CHECK_LABEL[check]} result`}>
          <option value="true">passes</option>
          <option value="false">fails</option>
        </select>
        <input name="evidenceUrl" maxLength={2000} className={inputClass} placeholder="https://… evidence" aria-label="Evidence link" />
        <input name="note" maxLength={1000} className={inputClass} placeholder="note" aria-label="Note" />
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Recording…' : 'Record check'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function PromoteBuildPanel({ projectId, environmentId, builds, promotedBuildId }: { projectId: string; environmentId: string; builds: { id: string; version: number; title: string; status: string }[]; promotedBuildId: string | null }) {
  const [state, action, pending] = useActionState(promoteBuildAction, IDLE_STATE);
  if (builds.length === 0) return <p className="text-xs text-muted">No build to promote yet.</p>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="environmentId" value={environmentId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Build</span>
        <select name="deliverableId" className={selectClass} defaultValue={builds.find((b) => b.id !== promotedBuildId)?.id ?? builds[0]?.id}>
          {builds.map((b) => (
            <option key={b.id} value={b.id}>
              v{b.version} — {b.title} ({b.status.replace('_', ' ')}){b.id === promotedBuildId ? ' · promoted' : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Promoting…' : 'Promote build after gates'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function TriggerBuildPanel({ projectId, workflowFile, linked }: { projectId: string; workflowFile: string | null; linked: boolean }) {
  const [state, action, pending] = useActionState(triggerBuildAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex min-w-56 flex-col gap-1">
        <span className={labelClass}>Note</span>
        <input name="note" maxLength={500} className={inputClass} placeholder="why this build (optional)" />
      </label>
      <button type="submit" disabled={pending || !linked} className={buttonClass('primary', 'sm')} title={linked ? undefined : 'Link a GitHub repository on the Repository tab first'}>
        {pending ? 'Triggering…' : 'Trigger build'}
      </button>
      <span className="text-xs text-muted">
        {!linked ? 'no repository linked — nothing to trigger' : workflowFile ? `records and dispatches ${workflowFile} on GitHub Actions` : 'records only — no workflow file linked on the Repository tab'}
      </span>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/**
 * Owner decision 13 (round 2) — run the contract and migration checks of this
 * environment as a GitHub workflow from the panel. Dispatches through
 * `dispatchEnvironmentChecksAction` (the repository policy and the secrets
 * resolver's token apply); the result is read back with "Read result" and
 * recorded on the checks below with the run's link as evidence. Recording a
 * check by hand with the row's own form still works and is the fallback.
 */
export function RunChecksPanel({ projectId, environmentId, linked }: { projectId: string; environmentId: string; linked: boolean }) {
  const [state, action, pending] = useActionState(dispatchEnvironmentChecksAction, IDLE_STATE);
  const id = useId();
  if (!linked) {
    return <p className="text-xs text-muted">No repository is linked, so the checks cannot run on GitHub. Record them by hand below.</p>;
  }
  return (
    <form action={action} className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-sunken p-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="environmentId" value={environmentId} />
      <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <legend className="sr-only">Checks to run on GitHub</legend>
        {CHECK_RUN_CHECKS.map((c) => (
          <label key={c} className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" name="checks" value={c} defaultChecked />
            {CHECK_RUN_CHECK_LABEL[c]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${id}-wf`} className="text-xs text-muted">Workflow file</label>
      <input id={`${id}-wf`} name="workflowFile" maxLength={130} className={inputClass} placeholder={DEFAULT_CHECKS_WORKFLOW} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Dispatching…' : 'Run checks on GitHub'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** The status read: what GitHub says about the dispatched checks of this environment. */
export function ReadCheckResultButton({ projectId, environmentId }: { projectId: string; environmentId: string }) {
  const [state, action, pending] = useActionState(refreshEnvironmentChecksAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="environmentId" value={environmentId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Reading…' : 'Read result'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
