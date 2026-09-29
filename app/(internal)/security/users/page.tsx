import type { Metadata } from 'next';
import Link from 'next/link';

import { MemberRolesPanel } from '../../settings/member-roles-panel';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { agencyClock } from '@/lib/admin/agency-clock';
import { readLatestAccessReviews } from '@/modules/identity/access-reviews-queries';
import { listInternalRosterWithRoles } from '@/modules/projects/queries';
import { Card, CardHeader, PageHeader, PermissionDenied } from '@/ui';

import { AccessReviewPanel } from './access-review-panel';

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
  if (!can(context, 'organization.settings')) return <PermissionDenied />;

  const clock = await agencyClock();
  const [roster, reviews] = await Promise.all([listInternalRosterWithRoles(), readLatestAccessReviews()]);
  const reviewable = roster.map((m) => {
    const r = reviews.get(m.membershipId);
    return {
      membershipId: m.membershipId,
      fullName: m.fullName,
      email: m.email,
      role: m.role,
      secondaryRoles: m.secondaryRoles,
      status: m.status,
      lastReview: r ? { ...r, reviewedAtLabel: clock.dateTime(r.reviewedAt) } : null,
    };
  });
  const neverReviewed = reviewable.filter((m) => m.lastReview === null).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Users & roles"
        description="Every internal membership, its primary role, any additional roles granted, and whether their access is active or suspended."
      />

      <MemberRolesPanel members={roster} />

      {/* SCR-069: review access — confirm it stands, or ask for it to go. */}
      <Card>
        <CardHeader
          title="Access review"
          description={`Each membership's last review and what was decided${neverReviewed > 0 ? ` — ${neverReviewed} never reviewed` : ''}. A revocation request records the judgement; suspend the membership above to act on it. Every review is audited.`}
        />
        <AccessReviewPanel members={reviewable} />
      </Card>

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
