'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { setRepositoryPolicyAction } from '@/modules/projects/git-write-actions';
import { ACCESS_LEVEL_LABEL, ACCESS_LEVELS, MERGE_ROLE_LABEL, MERGE_ROLES, type AccessLevel, type MergeRole } from '@/modules/projects/repository-policy';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/** SCR-042 — the owner's or ops admin's form for the repository's access level and merge policy (`projects.set_repository_policy`). */
export function RepositoryPolicyForm({
  projectId,
  accessLevel,
  mergeMinApprovals,
  mergeRole,
}: {
  projectId: string;
  accessLevel: AccessLevel;
  mergeMinApprovals: number;
  mergeRole: MergeRole;
}) {
  const [state, action, pending] = useActionState(setRepositoryPolicyAction, IDLE_STATE);
  const ids = { level: useId(), role: useId(), approvals: useId() };
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.level} className={labelClass}>What the panel may do here</label>
        <select id={ids.level} name="accessLevel" defaultValue={accessLevel} className={selectClass}>
          {ACCESS_LEVELS.map((l) => (
            <option key={l} value={l}>
              {ACCESS_LEVEL_LABEL[l]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.role} className={labelClass}>Who may merge</label>
        <select id={ids.role} name="mergeRole" defaultValue={mergeRole} className={selectClass}>
          {MERGE_ROLES.map((r) => (
            <option key={r} value={r}>
              {MERGE_ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.approvals} className={labelClass}>Approving reviews needed</label>
        <input id={ids.approvals} name="mergeMinApprovals" type="number" min={0} max={5} defaultValue={mergeMinApprovals} className={inputClass} />
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save Policy'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
