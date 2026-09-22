import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { MemberRolesPanel } from '../../settings/member-roles-panel';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInternalRosterWithRoles } from '@/modules/projects/queries';
import { PageHeader } from '@/ui';

export const metadata: Metadata = { title: 'Users & roles' };

/**
 * Users & Roles — the PDF's SCR-069 split this repo never had: /security was
 * structural RLS invariants only, and the actual roster/role controls were
 * reachable solely through the Settings → Team tab, a page whose capability
 * gate (organization.settings) is stricter than who should be ABLE TO SEE who
 * holds what.
 *
 * This page is a second entry point to the SAME panel and the SAME server
 * actions Settings → Team already uses (member-roles-panel.tsx,
 * setMembershipStatusAction, grant/revokeSecondaryRoleAction) — not a parallel
 * implementation. Gated on organization.settings, same as the writes it
 * performs, because seeing who can grant themselves capabilities is itself
 * sensitive.
 */
export default async function UsersAndRolesPage() {
  const context = await requireInternal('/security/users');
  if (!can(context.role, 'organization.settings')) redirect('/security');

  const roster = await listInternalRosterWithRoles();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Users & roles"
        description="Every internal membership, its primary role, any additional roles granted, and whether their access is active or suspended."
      />

      <MemberRolesPanel members={roster} />

      <p className="text-xs leading-relaxed text-muted">
        Inviting a new person still needs a Supabase Auth invite (email delivery, account
        creation) — there is no self-serve invite flow in the product yet; a new teammate is added
        to <code className="font-mono">core.memberships</code> once their account exists. For the
        default team a new project group card is prepared with, see{' '}
        <Link href="/settings/team" className="font-medium text-brand underline-offset-2 hover:underline">
          Settings → Team
        </Link>
        .
      </p>
    </div>
  );
}
