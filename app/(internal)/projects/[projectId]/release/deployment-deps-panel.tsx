'use client';

import { useActionState } from 'react';

import { setDeploymentDependencyAction } from '@/modules/projects/deployment-deps-actions';
import type { DeploymentDependency } from '@/modules/projects/deployment-deps-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, FormMessage, inputClass } from '@/ui';

/**
 * SCR-049 — deployment dependencies on the release candidate's handover
 * (`projects.set_deployment_dependency`). A report beside the gate: the
 * sign-off door does not read it, and the card says so.
 */
export function DeploymentDependencies({
  projectId,
  handoverId,
  dependencies,
  editable,
}: {
  projectId: string;
  handoverId: string;
  dependencies: DeploymentDependency[];
  editable: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {dependencies.length === 0 ? (
        <p className="text-[13px] text-muted">No deployment dependency listed.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {dependencies.map((d) => (
            <li key={d.label} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
              <span className="flex items-center gap-2">
                <Badge tone={d.status === 'ready' ? 'success' : 'warning'}>{d.status}</Badge>
                <span>{d.label}</span>
              </span>
              {editable ? <DependencyRow projectId={projectId} handoverId={handoverId} label={d.label} status={d.status} /> : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? <DependencyRow projectId={projectId} handoverId={handoverId} label="" status="pending" isNew /> : null}
    </div>
  );
}

function DependencyRow({ projectId, handoverId, label, status, isNew }: { projectId: string; handoverId: string; label: string; status: 'pending' | 'ready'; isNew?: boolean }) {
  const [state, action, pending] = useActionState(setDeploymentDependencyAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="handoverId" value={handoverId} />
      {isNew ? (
        <input name="label" required maxLength={200} placeholder="DNS cutover, vendor API key, client sign-off…" aria-label="Dependency" className={`${inputClass} h-8 min-w-56 flex-1 text-xs`} />
      ) : (
        <input type="hidden" name="label" value={label} />
      )}
      {isNew ? (
        <button type="submit" name="status" value="pending" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Adding…' : 'Add'}
        </button>
      ) : (
        <>
          <button type="submit" name="status" value={status === 'ready' ? 'pending' : 'ready'} disabled={pending} className={buttonClass('ghost', 'sm')}>
            {status === 'ready' ? 'Mark pending' : 'Mark ready'}
          </button>
          <button type="submit" name="remove" value="true" disabled={pending} className={buttonClass('ghost', 'sm')}>
            Remove
          </button>
        </>
      )}
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
