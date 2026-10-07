import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readSchedulingPolicy } from '@/modules/crm/p1o-scheduling-service';
import { readOverlapRule } from '@/modules/crm/p1r-scheduling-drafts';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, buttonClass } from '@/ui';

import { OverlapRuleForm } from './overlap-form';
import { PolicyForm } from './policy-form';

export const metadata: Metadata = { title: 'Scheduling policy' };

/**
 * The rules the Scheduler works to (P1-SCHED-014/018/020/026), as the organisation's own settings rather than constants in code: working hours, the notice and
 * buffer, the durations offered and how long an offer stays open. An organisation that has saved nothing runs on the old defaults and the page says so.
 */
export default async function SchedulingPolicyPage() {
  const context = await requireInternal('/meetings/policy');
  if (!can(context, 'lead.read')) return <PermissionDenied />;
  if (!context.organizationId) return <EmptyState title="No organisation" description="Sign in to an organisation to see its policy." />;
  const [policy, overlap] = await Promise.all([readSchedulingPolicy(context.organizationId), readOverlapRule()]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Scheduling policy"
        description="The hours, notice, buffer, durations and offer expiry the Scheduler works to."
        meta={<Badge tone={policy.configured ? 'success' : 'neutral'} dot>{policy.configured ? 'Saved by your team' : 'Using the built-in defaults'}</Badge>}
        actions={<Link href="/meetings/attention" className={buttonClass('secondary', 'sm')}>Meetings that need a person</Link>}
      />
      <Card>
        <CardBody>
          <PolicyForm policy={policy} canEdit={can(context, 'organization.settings')} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Overlapping meetings"
          description="Whether the database refuses a booking that overlaps another booked meeting of this organisation. It assumes one booking calendar, the one availability is read from. Nobody has decided per-person calendars, so this stays off until you switch it on."
        />
        <CardBody>
          <p className="mb-2 text-sm">
            <Badge tone={overlap?.preventOverlap ? 'success' : 'neutral'} dot>{overlap?.preventOverlap ? 'On' : overlap?.configured ? 'Off (decided)' : 'Off (not decided)'}</Badge>
            {overlap?.reason ? <span className="ml-2 text-xs text-muted">{overlap.reason}</span> : null}
          </p>
          <OverlapRuleForm current={overlap?.preventOverlap === true} canEdit={can(context, 'organization.settings')} />
        </CardBody>
      </Card>
    </div>
  );
}
