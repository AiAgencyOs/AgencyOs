'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { addProjectMemberAction, removeProjectMemberAction, setProjectMemberRoleAction } from '@/modules/projects/project-members-actions';
import type { ProjectMember } from '@/modules/projects/project-members-queries';
import { PROJECT_ROLE_LABEL, PROJECT_ROLES } from '@/modules/projects/project-members-schema';
import { Avatar, Badge, buttonClass, FormMessage, humanize, labelClass, selectClass } from '@/ui';

/**
 * SCR-025 — the project's own roster: assign a member, set their project
 * role, remove them. Three doors in project-members-actions; every refusal
 * (not an active member, already on the project) is the database's own,
 * shown beside the control that earned it.
 */
export function ProjectMembersPanel({
  projectId,
  members,
  roster,
  lastActive,
  lastActiveLabels,
  mayEdit,
}: {
  projectId: string;
  members: ProjectMember[];
  roster: { userId: string; fullName: string; role: string }[];
  lastActive: { visible: false; reason: string } | { visible: true; byUser: Record<string, string> };
  /** Pre-formatted "last active" labels keyed by user id. */
  lastActiveLabels: Record<string, string>;
  mayEdit: boolean;
}) {
  const onProject = new Set(members.map((m) => m.userId));
  const candidates = roster.filter((r) => !onProject.has(r.userId));

  return (
    <div className="flex flex-col gap-2">
      {members.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Nobody has been put on this project yet{mayEdit ? ' — assign someone below.' : '.'} Task assignees are still listed above.</p>
      ) : (
        <ul className="divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px] sm:px-5">
              <Avatar name={m.fullName} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{m.fullName}</span>
                <span className="block truncate text-xs text-muted">
                  {humanize(m.orgRole)}
                  {' · '}
                  {lastActive.visible ? (lastActiveLabels[m.userId] ? `last active ${lastActiveLabels[m.userId]}` : 'no recorded activity') : 'activity not visible to your role'}
                </span>
              </span>
              {mayEdit ? <RoleForm projectId={projectId} memberId={m.id} current={m.projectRole} /> : <Badge tone="info">{PROJECT_ROLE_LABEL[m.projectRole]}</Badge>}
              {mayEdit ? <RemoveMemberButton projectId={projectId} memberId={m.id} name={m.fullName} /> : null}
            </li>
          ))}
        </ul>
      )}
      {!lastActive.visible ? <p className="px-4 text-xs text-muted sm:px-5">{lastActive.reason}</p> : null}
      {mayEdit ? <AddMemberForm projectId={projectId} candidates={candidates} /> : null}
    </div>
  );
}

function AddMemberForm({ projectId, candidates }: { projectId: string; candidates: { userId: string; fullName: string; role: string }[] }) {
  const [state, action, pending] = useActionState(addProjectMemberAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3 sm:px-5">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Assign</span>
        <select name="userId" required defaultValue="" className={selectClass} disabled={candidates.length === 0}>
          <option value="" disabled>
            {candidates.length === 0 ? 'Everyone on the roster is already here' : 'Pick a person'}
          </option>
          {candidates.map((c) => (
            <option key={c.userId} value={c.userId}>
              {c.fullName} · {humanize(c.role)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Project role</span>
        <select name="projectRole" defaultValue="contributor" className={selectClass}>
          {PROJECT_ROLES.map((r) => (
            <option key={r} value={r}>{PROJECT_ROLE_LABEL[r]}</option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending || candidates.length === 0} className={buttonClass('primary', 'sm')}>
        {pending ? 'Adding…' : 'Add to project'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function RoleForm({ projectId, memberId, current }: { projectId: string; memberId: string; current: string }) {
  const [state, action, pending] = useActionState(setProjectMemberRoleAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-1" key={current}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="memberId" value={memberId} />
      <select name="projectRole" defaultValue={current} className={selectClass} aria-label="Project role" onChange={(e) => e.currentTarget.form?.requestSubmit()} disabled={pending}>
        {PROJECT_ROLES.map((r) => (
          <option key={r} value={r}>{PROJECT_ROLE_LABEL[r]}</option>
        ))}
      </select>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

function RemoveMemberButton({ projectId, memberId, name }: { projectId: string; memberId: string; name: string }) {
  const [state, action, pending] = useActionState(removeProjectMemberAction, IDLE_STATE);
  return (
    <form
      action={action}
      className="inline-flex items-center gap-1"
      onSubmit={(e) => {
        if (!window.confirm(`Remove ${name} from this project? Their tasks stay assigned.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="memberId" value={memberId} />
      <button type="submit" disabled={pending} className="text-xs text-faint hover:text-danger">
        Remove
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
