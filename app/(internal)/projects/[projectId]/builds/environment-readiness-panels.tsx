'use client';

import { useActionState } from 'react';

import { promoteBuildAction, recordEnvironmentCheckAction } from '@/modules/projects/environment-readiness-actions';
import { READINESS_CHECK_LABEL, type ReadinessCheck } from '@/modules/projects/environment-readiness-schema';
import { triggerBuildAction } from '@/modules/projects/git-write-actions';
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
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Build</label>
        <select name="deliverableId" className={selectClass} defaultValue={builds.find((b) => b.id !== promotedBuildId)?.id ?? builds[0]?.id}>
          {builds.map((b) => (
            <option key={b.id} value={b.id}>
              v{b.version} — {b.title} ({b.status.replace('_', ' ')}){b.id === promotedBuildId ? ' · promoted' : ''}
            </option>
          ))}
        </select>
      </div>
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
      <div className="flex min-w-56 flex-col gap-1">
        <label className={labelClass}>Note</label>
        <input name="note" maxLength={500} className={inputClass} placeholder="why this build (optional)" />
      </div>
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
