import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Which milestone is "M1", "M2"... — by ORDER, never by a position number.
 *
 * `projects.milestones.position` is whatever the writer chose: the installer
 * (`projects.replace_payment_plan`) numbers a plan from 0, a hand-built fixture
 * from 1, and a person's plan from whatever they typed. The first draft of the
 * M1-M4 generators and gates assumed 1-based and the installer is 0-based, so
 * the "M1" invoice was raised for the SECOND milestone (found by driving the
 * whole Phase 2 flow). The meaning of M1 is "the first priced milestone of the
 * project's payment plan", and that is what is asked here.
 */
export async function pricedMilestones(
  admin: Admin,
  scope: { organizationId: string; projectId: string },
): Promise<Array<{ id: string; position: number }> | null> {
  const { data, error } = await admin
    .schema('projects')
    .from('milestones')
    .select('id, position, created_at')
    .eq('project_id', scope.projectId)
    .eq('organization_id', scope.organizationId)
    .not('payment_percent', 'is', null)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return null;
  return (data ?? []).map((m) => ({ id: m.id, position: m.position ?? 0 }));
}

/** True when `milestoneId` is the first priced milestone of its project's plan. Null when the plan could not be read. */
export async function isAdvanceMilestone(
  admin: Admin,
  scope: { organizationId: string; projectId: string; milestoneId: string },
): Promise<boolean | null> {
  const plan = await pricedMilestones(admin, scope);
  if (!plan) return null;
  return plan[0]?.id === scope.milestoneId;
}
