import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readCampaignDetail } from '@/modules/crm/outreach/queries';
import { Callout, Card, CardBody, CardHeader, PageHeader, PermissionDenied, Stat, StatGrid, StatusBadge } from '@/ui';

import { CampaignControls } from '../forms';

export const metadata: Metadata = { title: 'Email campaign' };

export default async function EmailCampaignPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const context = await requireInternal(`/communication/email-outreach/${campaignId}`);
  if (!can(context, 'lead.write')) return <PermissionDenied />;
  const [detail, clock] = await Promise.all([readCampaignDetail(campaignId), agencyClock()]);
  if (!detail) notFound();
  const { campaign: c } = detail;
  const total = detail.sends.sent + detail.sends.bounced;
  const bounceRate = total > 0 ? Math.round((detail.sends.bounced / total) * 1000) / 10 : 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Email outreach"
        title={c.name}
        description={`Created ${clock.dateTime(c.createdAt)}`}
        meta={<StatusBadge status={c.status} />}
        actions={
          <Link href="/communication/email-outreach" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
            All outreach
          </Link>
        }
      />
      {c.pausedReason ? <Callout tone="warning" title="Paused">{c.pausedReason}</Callout> : null}
      <StatGrid>
        <Stat label="People" value={String(c.recipientCount ?? 0)} caption={c.recipientCount === null ? 'frozen at approval' : 'frozen at approval'} tone="neutral" />
        <Stat label="Sent" value={String(detail.sends.sent)} tone="success" />
        <Stat label="Bounced" value={String(detail.sends.bounced)} caption={`${bounceRate}% of delivered attempts`} tone={detail.sends.bounced > 0 ? 'warning' : 'neutral'} />
        <Stat label="Unsubscribed" value={String(detail.byStatus.unsubscribed ?? 0)} tone="neutral" />
      </StatGrid>

      <Card>
        <CardHeader title="Controls" />
        <CardBody>
          <CampaignControls campaignId={c.id} status={c.status} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Steps" />
        <CardBody>
          <ol className="flex flex-col gap-1 text-[13px]">
            {detail.steps.map((s) => (
              <li key={s.stepNumber}>
                Step {s.stepNumber}: <strong>{s.templateName}</strong> {s.stepNumber === 1 ? '- sent at once' : `- ${s.delayDays} day${s.delayDays === 1 ? '' : 's'} after step ${s.stepNumber - 1}, unless they reply or unsubscribe`}
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Where everyone stands" />
        <CardBody>
          <ul className="flex flex-wrap gap-3 text-[13px]">
            {Object.entries(detail.byStatus).map(([status, n]) => (
              <li key={status}>
                <StatusBadge status={status} /> {n}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Latest sends" />
        <CardBody>
          {detail.recent.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing sent yet.</p>
          ) : (
            <ul className="divide-y divide-line text-[13px]">
              {detail.recent.map((s, i) => (
                <li key={`${s.email}-${s.stepNumber}-${i}`} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span>
                    {s.email} <span className="text-muted">· step {s.stepNumber}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {s.sentAt ? clock.dateTime(s.sentAt) : ''} <StatusBadge status={s.status} />
                    {s.error ? <span className="text-danger">{s.error.slice(0, 60)}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
