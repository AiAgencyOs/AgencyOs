import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listCampaigns, listCampaignTemplates, readAudienceFacets, type CampaignListRow } from '@/modules/crm/campaign-queries';
import { describeAudience } from '@/modules/crm/campaign-schema';
import { LEAD_STATUSES } from '@/modules/crm/schema';
import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  IconSend,
  PageHeader,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  type Column,
} from '@/ui';

import { NewCampaignForm } from './new-campaign-form';

export const metadata: Metadata = { title: 'Campaigns' };

/**
 * Campaigns — SCR-059's broadcast, reopened by the owner on 2026-09-30 as a
 * governed campaign.
 *
 * A campaign is not a send. It is a plan (an approved template and the
 * Leads list's filter) that a SECOND owner or ops admin approves, and that
 * the cron tick then expands into one per-thread message per recipient —
 * each through the same door the composer uses, so consent, the 24-hour
 * window, the outreach allowance and the template's facts decide every
 * person separately. What the rules refuse is recorded with its reason on
 * the campaign's page; nothing is bypassed and nothing is dropped silently.
 *
 * `lead.write` gates the page: planning a campaign is writing to leads.
 */
const columnsFor = (clock: AgencyClock): Column<CampaignListRow>[] => [
  { key: 'name', header: 'Campaign', primary: true, cell: (c) => c.name },
  { key: 'status', header: 'Status', badge: true, cell: (c) => <StatusBadge status={c.status} /> },
  {
    key: 'template',
    header: 'Template',
    desktopOnly: true,
    cellClassName: 'text-muted',
    cell: (c) => (c.templateName ? `${c.templateName} · ${c.languageCode ?? ''}` : '—'),
  },
  { key: 'audience', header: 'Audience', desktopOnly: true, cellClassName: 'text-muted', cell: (c) => describeAudience(c.audience) },
  {
    key: 'progress',
    header: 'Progress',
    cell: (c) =>
      c.status === 'draft' ? (
        <span className="text-muted">Awaiting approval</span>
      ) : (
        <span className="flex items-center gap-2">
          <ProgressBar
            value={c.recipients > 0 ? ((c.sent + c.refused + c.failed) / c.recipients) * 100 : 0}
            size="sm"
            label={`${c.name} progress`}
            className="w-28"
          />
          <span className="tabular text-xs text-muted">
            {c.sent} sent · {c.refused} refused{c.failed > 0 ? ` · ${c.failed} failed` : ''} / {c.recipients}
          </span>
        </span>
      ),
  },
  { key: 'by', header: 'Planned by', desktopOnly: true, cellClassName: 'text-muted', cell: (c) => c.createdByEmail ?? '—' },
  { key: 'created', header: 'Created', align: 'right', cellClassName: 'text-muted', cell: (c) => clock.dateTime(c.createdAt) },
];

export default async function CampaignsPage() {
  const context = await requireInternal('/communication/campaigns');
  if (!can(context.role, 'lead.write')) return <PermissionDenied />;

  const [campaigns, templates, facets, clock] = await Promise.all([listCampaigns(), listCampaignTemplates(), readAudienceFacets(), agencyClock()]);

  const count = (status: CampaignListRow['status']) => campaigns.filter((c) => c.status === status).length;
  const sentTotal = campaigns.reduce((n, c) => n + c.sent, 0);
  const refusedTotal = campaigns.reduce((n, c) => n + c.refused + c.failed, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Campaigns"
        description="A template to many leads, one governed message at a time. Planned by one person, approved by another, sent by the tick through the consent, window and outreach rules."
      />

      <StatGrid cols={5}>
        <Stat label="Drafts" value={String(count('draft'))} caption="Waiting for a second approver" tone={count('draft') > 0 ? 'warning' : 'neutral'} />
        <Stat label="Approved" value={String(count('approved'))} caption="The next tick starts them" tone="brand" />
        <Stat label="Running" value={String(count('running'))} caption="25 recipients per tick at most" tone="info" icon={<IconSend size={16} />} />
        <Stat label="Sent" value={String(sentTotal)} caption="Across every campaign" tone="success" />
        <Stat label="Refused or failed" value={String(refusedTotal)} caption="Each with its reason on the campaign" tone={refusedTotal > 0 ? 'danger' : 'neutral'} />
      </StatGrid>

      <Card>
        <CardHeader title="New campaign" description="Saved as a draft. Nothing is sent until a second owner or ops admin approves it." />
        <CardBody>
          <NewCampaignForm templates={templates} statuses={LEAD_STATUSES} sources={facets.sources} owners={facets.owners} services={facets.services} />
        </CardBody>
      </Card>

      <Callout tone="info" title="What a campaign may not do">
        It never sends free text, never sends to a contact without recorded consent, never exceeds the outreach limits under Settings › Communication, and never fills a template variable with a guess. A recipient the rules refuse is listed on the campaign with the reason.
      </Callout>

      <Card>
        <CardHeader title="All campaigns" description={campaigns.length === 0 ? 'None planned yet.' : `${campaigns.length} planned.`} />
        {campaigns.length === 0 ? (
          <CardBody>
            <EmptyState title="No campaigns yet" description="Plan one above: pick an approved template and an audience, save the draft, and ask a second owner or ops admin to approve it." />
          </CardBody>
        ) : (
          <DataTable rows={campaigns} columns={columnsFor(clock)} getKey={(c) => c.id} href={(c) => `/communication/campaigns/${c.id}`} dense />
        )}
      </Card>
    </div>
  );
}
