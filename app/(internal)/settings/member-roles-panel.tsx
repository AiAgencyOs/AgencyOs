'use client';

import { useActionState } from 'react';

import { grantSecondaryRoleAction, revokeSecondaryRoleAction } from './actions';
import type { RosterMemberWithRoles } from '@/modules/projects/queries';
import { INTERNAL_ROLES } from '@/lib/auth/claims';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass } from '@/ui';

/**
 * Multirole — G-310.
 *
 * Every membership still has exactly one primary role, shown here as it has
 * always been shown on the roster. What this panel adds is a way for an
 * owner to grant a person one or more ADDITIONAL roles, so their effective
 * capabilities become the union of every role they hold
 * (`src/lib/authz/permissions.ts`'s `effectiveCapabilitiesFor`).
 *
 * **Said plainly, because it is easy to assume otherwise**: a secondary role
 * granted here widens what a person may DO in server actions and admin pages
 * that explicitly check the union — it does not widen what rows they can read
 * or write through Row Level Security, which still reads only the primary
 * role from their session token. Two different things, and this panel is
 * the place that says so rather than leaving it to be discovered.
 */

function GrantForm({ membershipId, alreadyHeld }: { membershipId: string; alreadyHeld: readonly string[] }) {
  const [state, action, pending] = useActionState(grantSecondaryRoleAction, IDLE_STATE);
  const grantable = INTERNAL_ROLES.filter((role) => !alreadyHeld.includes(role));

  if (grantable.length === 0) {
    return <span className="text-xs text-muted">Every role is already held.</span>;
  }

  return (
    <form action={action} className="flex items-center gap-1">
      <input type="hidden" name="membershipId" value={membershipId} />
      <select name="role" className="rounded-md border border-line bg-surface px-2 py-1 text-[13px]" defaultValue="">
        <option value="" disabled>
          Add a role…
        </option>
        {grantable.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
      <button type="submit" className={buttonClass('secondary', 'sm')} disabled={pending}>
        {pending ? 'Granting…' : 'Grant'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

function RevokeButton({ membershipId, role }: { membershipId: string; role: string }) {
  const [state, action, pending] = useActionState(revokeSecondaryRoleAction, IDLE_STATE);

  return (
    <form action={action} className="inline-flex items-center gap-1">
      <input type="hidden" name="membershipId" value={membershipId} />
      <input type="hidden" name="role" value={role} />
      <Badge tone="neutral">
        {role}
        <button
          type="submit"
          className="ml-1 text-muted hover:text-danger"
          disabled={pending}
          aria-label={`Revoke ${role}`}
        >
          ×
        </button>
      </Badge>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

function MemberRow({ member }: { member: RosterMemberWithRoles }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{member.fullName}</span>
        <span className="text-muted">{member.email}</span>
        <Badge tone="brand">{member.role}</Badge>
        {member.secondaryRoles.map((role) => (
          <RevokeButton key={role} membershipId={member.membershipId} role={role} />
        ))}
      </span>
      <GrantForm membershipId={member.membershipId} alreadyHeld={[member.role, ...member.secondaryRoles]} />
    </li>
  );
}

export function MemberRolesPanel({ members }: { members: RosterMemberWithRoles[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold tracking-tight">Roles</h2>
      <p className="text-xs text-muted">
        Every person keeps exactly one primary role (the badge on the left). An owner may also
        grant additional roles — their effective capabilities become the union of every role they
        hold. Owner only.
      </p>
      <p className="text-xs text-muted">
        A secondary role widens what a person may do in the pages and actions that check for it.
        It does not widen which database rows they can read or write — that is still governed by
        the primary role alone.
      </p>

      {members.length === 0 ? (
        <p className="text-[13px] text-muted">Nobody on the roster yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {members.map((member) => (
            <MemberRow key={member.membershipId} member={member} />
          ))}
        </ul>
      )}
    </div>
  );
}
