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
 * **Decision 2026-09-30 (F2): secondary roles are honoured by every
 * permission check.** `requireInternal()` loads them into `context.roles`
 * and every `can(context, capability)` in the app reads the union, so a
 * grant made here changes what its holder may do the moment it lands. In the
 * database, `core.is_owner()`, `core.is_admin()` and `core.can_write()`
 * consult the same grants (`core.holds_role`), so the owner-gated doors admit
 * a secondary owner too.
 *
 * **Said plainly, because it is easy to assume otherwise**: what a grant
 * does not do is widen the ROWS a person can read or write through the
 * policies that spell `core.current_user_role() in (...)` — those still read
 * the primary role from the session token. Nobody gets LESS than their
 * primary role grants; a secondary role only adds.
 */

function GrantForm({ membershipId, alreadyHeld }: { membershipId: string; alreadyHeld: readonly string[] }) {
  const [state, action, pending] = useActionState(grantSecondaryRoleAction, IDLE_STATE);
  const grantable = INTERNAL_ROLES.filter((role) => !alreadyHeld.includes(role));

  if (grantable.length === 0) {
    return <span className="text-xs text-muted">Every role is already held.</span>;
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-1">
      <input type="hidden" name="membershipId" value={membershipId} />
      <select name="role" aria-label="Role to grant" className="rounded-md border border-line bg-surface px-2 py-1 text-[13px]" defaultValue="">
        <option value="" disabled>
          Add a role…
        </option>
        {grantable.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
      <input name="reason" required minLength={3} maxLength={500} placeholder="why" aria-label="Reason for granting the role" className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-[13px]" />
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
      <input name="reason" required minLength={3} maxLength={500} placeholder="why revoke" aria-label={`Reason for revoking ${role}`} className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-xs" />
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
      <input name="reason" required minLength={3} maxLength={500} placeholder={status === 'active' ? 'why suspend' : 'why reactivate'} aria-label={status === 'active' ? 'Reason for suspending' : 'Reason for reactivating'} className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-xs" />
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
        Since 2026-09-30 every permission check honours a secondary role: the pages and actions its
        holder may use widen the moment the grant lands, and the owner-only doors in the database
        admit a secondary owner. It does not widen which database rows they can read or write
        under the row policies that read the primary role alone.
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
