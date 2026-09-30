import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { readAuditLog } from '@/lib/audit/queries';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { readCampaignSendPreview } from '@/modules/crm/campaign-preview-queries';
import { getCampaign, listCampaignRecipients, readAudienceCandidates, type CampaignRecipientRow } from '@/modules/crm/campaign-queries';
import { describeAudience, expandAudience } from '@/modules/crm/campaign-schema';
import { describeRefusal } from '@/modules/crm/campaign-types';
import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  DetailFields,
  EmptyState,
  IconArrowLeft,
  PageHeader,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  type Column,
} from '@/ui';

import { ApproveCampaignForm, CancelCampaignForm } from './controls';

export const metadata: Metadata = { title: 'Campaign' };

/**
 * One campaign — SCR-059, owner decision 2026-09-30.
 *
 * The plan, who planned and who approved it, the progress, and every
 * recipient with what happened to them: sent (with a link to the thread),
 * refused (with the reason from the closed set), failed (with the
 * provider's words). Approve is shown to a second owner or ops admin only;
 * Cancel to the person who planned it or the owner; both are decided again
 * in the database.
 */
const recipientColumns = (clock: AgencyClock): Column<CampaignRecipientRow>[] => [
  {
    key: 'lead',
    header: 'Lead',
    primary: true,
    cell: (r) =>
      r.leadId ? (
        <Link href={`/leads/${r.leadId}`} className="underline-offset-2 hover:underline">
          {r.leadTitle ?? r.leadId}
        </Link>
      ) : (
        (r.leadTitle ?? '—')
      ),
  },
  { key: 'status', header: 'Outcome', badge: true, cell: (r) => <StatusBadge status={r.status} /> },
  {
    key: 'reason',
    header: 'Reason',
    cellClassName: 'text-muted',
    cell: (r) => (r.status === 'sent' ? 'Sent through the governed door' : describeRefusal(r.reason)),
  },
  {
    key: 'thread',
    header: 'Thread',
    desktopOnly: true,
    cell: (r) =>
      r.conversationId && r.leadId ? (
        <Link href={`/leads/${r.leadId}`} className="text-[12.5px] text-muted underline-offset-2 hover:underline">
          Open thread
        </Link>
      ) : (
        <span className="text-muted">—</span>
      ),
  },
  { key: 'decided', header: 'Decided', align: 'right', cellClassName: 'text-muted', cell: (r) => (r.decidedAt ? clock.dateTime(r.decidedAt) : 'Pending') },
];

export default async function CampaignPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const context = await requireInternal(`/communication/campaigns/${campaignId}`);
  if (!can(context, 'lead.write')) return <PermissionDenied />;

  const campaign = await getCampaign(campaignId);
  if (!campaign) notFound();

  const [recipients, clock, trail, preview] = await Promise.all([
    listCampaignRecipients(campaignId),
    agencyClock(),
    readAuditLog({ subjectId: campaignId, limit: 20 }),
    // SCR-059 (bucket F): what the first recipients would be handed — the
    // template and its variables filled from recorded facts.
    readCampaignSendPreview({ id: campaign.id, status: campaign.status, templateId: campaign.templateId, audience: campaign.audience }),
  ]);

  // For a draft, what approval WOULD write, from the same rows and the same
  // pure function — so the approver reads the number they are approving.
  const recipientsNow = campaign.status === 'draft' ? expandAudience(await readAudienceCandidates(), campaign.audience, new Date()).length : null;

  const decided = campaign.sent + campaign.refused + campaign.failed;
  const pending = Math.max(0, campaign.recipients - decided);
  const mayApprove = campaign.status === 'draft' && campaign.createdBy !== context.userId;
  const mayCancel = campaign.status !== 'done' && campaign.status !== 'cancelled' && (campaign.createdBy === context.userId || hasRole(context, 'owner'));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={
          <Link href="/communication/campaigns" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-foreground">
            <IconArrowLeft size={12} /> Campaigns
          </Link>
        }
        title={campaign.name}
        meta={<StatusBadge status={campaign.status} />}
        description={`${campaign.templateName ?? 'Template'} · ${campaign.languageCode ?? ''} — to ${describeAudience(campaign.audience)}.`}
      />

      {campaign.status === 'draft' ? (
        <StatGrid cols={4}>
          <Stat label="Recipients right now" value={String(recipientsNow ?? 0)} caption="From the saved filter, at this moment" tone="brand" />
          <Stat label="Sent" value="0" caption="A draft sends nothing" />
        </StatGrid>
      ) : (
        <StatGrid cols={5}>
          <Stat label="Recipients" value={String(campaign.recipients)} caption="Expanded at approval" tone="brand" />
          <Stat label="Sent" value={String(campaign.sent)} tone="success" />
          <Stat label="Refused" value={String(campaign.refused)} caption="By the consent, phone, limit or template rules" tone={campaign.refused > 0 ? 'warning' : 'neutral'} />
          <Stat label="Failed" value={String(campaign.failed)} caption="The provider refused" tone={campaign.failed > 0 ? 'danger' : 'neutral'} />
          <Stat label="Pending" value={String(pending)} caption={campaign.status === 'running' ? 'Up to 25 per tick' : campaign.status === 'approved' ? 'The next tick starts' : undefined} tone="info" />
        </StatGrid>
      )}

      {campaign.status !== 'draft' ? (
        <ProgressBar value={campaign.recipients > 0 ? (decided / campaign.recipients) * 100 : 0} label="Recipients decided" tone={campaign.status === 'cancelled' ? 'danger' : 'success'} />
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Recipients" description={recipients.length === 0 ? (campaign.status === 'draft' ? 'Written at approval.' : 'None recorded.') : `${recipients.length} — every one with what happened to it.`} />
          {recipients.length === 0 ? (
            <CardBody>
              <EmptyState title={campaign.status === 'draft' ? 'Not expanded yet' : 'No recipients'} description={campaign.status === 'draft' ? 'The audience is expanded when a second owner or ops admin approves the draft.' : 'The approval wrote no recipient rows.'} />
            </CardBody>
          ) : (
            <DataTable rows={recipients} columns={recipientColumns(clock)} getKey={(r) => r.id} dense />
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="The plan" />
            <CardBody>
              <DetailFields
                rows={[
                  { label: 'Template', value: campaign.templateName ? `${campaign.templateName} · ${campaign.languageCode ?? ''}` : '—' },
                  { label: 'Audience', value: describeAudience(campaign.audience) },
                  { label: 'Send from', value: campaign.scheduledFor ? clock.dateTime(campaign.scheduledFor) : 'As soon as approved' },
                  { label: 'Planned by', value: campaign.createdByEmail ?? '—' },
                  { label: 'Created', value: clock.dateTime(campaign.createdAt) },
                  { label: 'Approved by', value: campaign.approvedByEmail ? `${campaign.approvedByEmail} · ${campaign.approvedAt ? clock.dateTime(campaign.approvedAt) : ''}` : 'Not yet' },
                  { label: 'Started', value: campaign.startedAt ? clock.dateTime(campaign.startedAt) : '—' },
                  { label: 'Finished', value: campaign.finishedAt ? clock.dateTime(campaign.finishedAt) : '—' },
                  ...(campaign.cancelledReason ? [{ label: 'Cancelled because', value: campaign.cancelledReason }] : []),
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Send preview"
              description={preview ? `${preview.templateName} · ${preview.languageCode} — the first ${preview.recipients.length} of ${preview.total}, each variable from recorded facts. A blank is what the worker refuses as a missing fact.` : 'The template could not be read.'}
            />
            <CardBody>
              {preview && preview.recipients.length > 0 ? (
                <ul className="flex flex-col gap-2 text-[13px]">
                  {preview.recipients.map((r) => (
                    <li key={r.leadId} className="rounded-lg border border-line bg-canvas px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Link href={`/leads/${r.leadId}`} className="font-medium underline-offset-2 hover:underline">{r.leadTitle}</Link>
                        {!r.conversationId ? <span className="text-xs text-warning">no WhatsApp thread — will be refused</span> : null}
                      </div>
                      <p className="mt-1 font-mono text-xs">
                        {preview.templateName}
                        {r.values.length > 0 ? `(${r.values.map((v) => `${v.name}=${v.value === null ? '∅' : JSON.stringify(v.value)}`).join(', ')})` : '()'}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">{preview ? 'Nobody matches the audience right now.' : ''}</p>
              )}
            </CardBody>
          </Card>

          {campaign.status === 'draft' ? (
            <Card>
              <CardHeader title="Approve" description="Four eyes: a second owner or ops admin, never the person who planned it." />
              <CardBody>
                {mayApprove ? (
                  <ApproveCampaignForm campaignId={campaign.id} recipientsNow={recipientsNow ?? 0} />
                ) : (
                  <Callout tone="info">
                    {campaign.createdBy === context.userId
                      ? 'You planned this campaign, so a second owner or ops admin has to approve it.'
                      : 'Only an owner or ops admin may approve a campaign.'}
                  </Callout>
                )}
              </CardBody>
            </Card>
          ) : null}

          {mayCancel ? (
            <Card>
              <CardHeader title="Cancel" description="By the person who planned it, or the owner. A reason is required." />
              <CardBody>
                <CancelCampaignForm campaignId={campaign.id} />
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Trail" description={trail.length === 0 ? 'Nothing recorded yet.' : 'From the audit log, newest first.'} />
            <CardBody>
              {trail.length === 0 ? (
                <p className="text-[13px] text-muted">No audit rows for this campaign.</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {trail.map((e) => (
                    <li key={e.id} className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-xs">{e.action}</span>
                      <span className="shrink-0 text-xs text-muted">{clock.dateTime(e.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
