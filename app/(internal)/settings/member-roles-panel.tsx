'use client';

import { useActionState } from 'react';

import { grantSecondaryRoleAction, revokeSecondaryRoleAction, setMembershipStatusAction } from './actions';
import type { RosterMemberWithRoles } from '@/modules/projects/queries';
import type { CostRateAccess, MemberCostRates } from '@/modules/team/cost-rate-types';
import { INTERNAL_ROLES } from '@/lib/auth/claims';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass } from '@/ui';

import { CostRateCell } from './cost-rate-cell';

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
 * granted here is designed to widen what a person may DO in server actions
 * and admin pages that explicitly check the union (`effectiveCapabilitiesFor`/
 * `canEffective`) — it does not widen what rows they can read or write
 * through Row Level Security, which still reads only the primary role from
 * their session token. Two different things, and this panel is the place
 * that says so rather than leaving it to be discovered.
 *
 * **A second thing worth saying plainly, confirmed 2026-09-26**: no server
 * action or admin page in this codebase calls `effectiveCapabilitiesFor` or
 * `canEffective` today — every `can(role, capability)` check in the app
 * still reads only the primary role, exactly as it did before this table
 * existed. A grant made here is recorded, shown on the roster, and revocable,
 * but it does not yet change what its holder can actually do anywhere. This
 * is not a bypass in the other direction either — nobody gets LESS than
 * their primary role grants — but an owner reading only the paragraph above
 * would reasonably expect an effect that does not exist yet. Deciding which
 * checks should honor the union first is a real scope call (every page? a
 * named few?) that this comment does not make for them.
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

function StatusToggle({ membershipId, status }: { membershipId: string; status: 'active' | 'suspended' }) {
  const [state, action, pending] = useActionState(setMembershipStatusAction, IDLE_STATE);
  const next = status === 'active' ? 'suspended' : 'active';

  return (
    <form action={action} className="inline-flex items-center gap-1">
      <input type="hidden" name="membershipId" value={membershipId} />
      <input type="hidden" name="status" value={next} />
      <button
        type="submit"
        className={buttonClass(status === 'active' ? 'ghost' : 'secondary', 'sm')}
        disabled={pending}
      >
        {pending ? 'Working…' : status === 'active' ? 'Suspend' : 'Reactivate'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

type CostRateProps = {
  /** Decision E2 of 2026-09-30 — the owner sets, ops_admin reads, nobody else sees the cell. */
  costRates?: Record<string, MemberCostRates>;
  costRateAccess?: CostRateAccess;
  /** Today's ISO day in agency time, the default "from" date of a new rate. */
  today?: string;
};

function MemberRow({ member, costRates, costRateAccess = 'none', today = '' }: { member: RosterMemberWithRoles } & CostRateProps) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{member.fullName}</span>
        <span className="text-muted">{member.email}</span>
        <Badge tone="brand">{member.role}</Badge>
        {member.status === 'suspended' ? <Badge tone="danger">suspended</Badge> : null}
        {member.secondaryRoles.map((role) => (
          <RevokeButton key={role} membershipId={member.membershipId} role={role} />
        ))}
      </span>
      <span className="flex items-center gap-2">
        <GrantForm membershipId={member.membershipId} alreadyHeld={[member.role, ...member.secondaryRoles]} />
        <StatusToggle membershipId={member.membershipId} status={member.status} />
      </span>
      {costRateAccess !== 'none' ? (
        <CostRateCell userId={member.userId} rates={costRates?.[member.userId]} access={costRateAccess} today={today} />
      ) : null}
    </li>
  );
}

export function MemberRolesPanel({ members, costRates, costRateAccess, today }: { members: RosterMemberWithRoles[] } & CostRateProps) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold tracking-tight">Roles</h2>
      <p className="text-xs text-muted">
        Every person keeps exactly one primary role (the badge on the left). An owner may also
        grant additional roles — their effective capabilities become the union of every role they
        hold. Owner only.
      </p>
      <p className="text-xs text-muted">
        A secondary role is designed to widen what a person may do in the pages and actions that
        check for it — but nothing in this product checks for it yet, so a grant here is recorded
        and shown without changing what its holder can actually do. Either way, it does not widen
        which database rows they can read or write — that is still governed by the primary role
        alone.
      </p>
      {costRateAccess && costRateAccess !== 'none' ? (
        <p className="text-xs text-muted">
          Cost rate (decision E2 of 2026-09-30): rupees per hour from a date, private to management. It
          prices logged hours on the project report for readers who may read money and touches no
          invoice. A log is priced at the rate in force on its own day, so a new rate never rewrites an
          earlier cost. {costRateAccess === 'set' ? 'Owner sets it; there is no edit or delete — correct a rate by setting the right one from the same date.' : 'Only the owner sets it.'}
        </p>
      ) : null}
      <p className="text-xs text-muted">
        Suspending a membership revokes access without deleting the person&rsquo;s history — their
        audit trail and authored records stay intact. It takes effect on their next sign-in or
        session refresh, not instantly, and the last remaining owner and your own membership
        cannot be suspended.
      </p>

      {members.length === 0 ? (
        <p className="text-[13px] text-muted">Nobody on the roster yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {members.map((member) => (
            <MemberRow key={member.membershipId} member={member} costRates={costRates} costRateAccess={costRateAccess} today={today} />
          ))}
        </ul>
      )}
    </div>
  );
}
