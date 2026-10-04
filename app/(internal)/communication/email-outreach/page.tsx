import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { emailTransportState } from '@/lib/email/transport';
import { listEmailCampaigns, listEmailTemplates, listProspects, listSuppressions, readOutreachSettings } from '@/modules/crm/outreach/queries';
import { Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat, StatGrid, StatusBadge } from '@/ui';

import { ApproveTemplateForm, CampaignForm, ImportForm, ProspectActions, SettingsForm, SuppressForm, TemplateForm } from './forms';

export const metadata: Metadata = { title: 'Email outreach' };

/**
 * Email outreach from info@ - lead generation and marketing, and nothing else (care@ carries what a client is owed).
 *
 * Everything here is a plan or a record; the cron tick sends, through one chokepoint that checks the owner's stop
 * switch, suppression, the lawful basis, an approved template, the sender identity and the daily cap. A second
 * person approves every template and every campaign, and an unsubscribe is permanent.
 */
export default async function EmailOutreachPage() {
  const context = await requireInternal('/communication/email-outreach');
  if (!can(context, 'lead.write')) return <PermissionDenied />;
  const isOwner = hasRole(context, 'owner');
  const mayApprove = can(context, 'audit.read');

  const [settings, transport, prospects, templates, campaigns, suppressions, clock] = await Promise.all([
    readOutreachSettings(),
    emailTransportState('outreach'),
    listProspects(),
    listEmailTemplates(),
    listEmailCampaigns(),
    listSuppressions(),
    agencyClock(),
  ]);
  const approved = templates.filter((t) => t.status === 'approved');
  const identityMissing = !settings?.senderName || !settings?.postalAddress;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Communication"
        title="Email outreach"
        description="Lead generation and email marketing from info@. Client mail (quotes, invoices, updates) goes from care@ and never from here."
      />

      {!transport.configured ? (
        <Callout tone="warning" title="The info@ mailbox is not connected">
          {transport.reason} Nothing can be sent until it is - set it under Security › Keys & secrets › Email.
        </Callout>
      ) : null}
      {identityMissing ? (
        <Callout tone="warning" title="Say who is writing and where">
          Every outreach email carries a sender name and a postal address. Until both are saved below, no campaign can be approved or sent.
        </Callout>
      ) : null}

      <StatGrid>
        <Stat label="People" value={String(Object.values(prospects.counts).reduce((a, b) => a + b, 0))} caption={`${prospects.counts.new ?? 0} not yet contacted`} tone="neutral" />
        <Stat label="Contacted" value={String(prospects.counts.contacted ?? 0)} caption={`${prospects.counts.replied ?? 0} replied`} tone="info" />
        <Stat label="Never email again" value={String(suppressions.length)} caption="unsubscribed, bounced, complained" tone={suppressions.length > 0 ? 'warning' : 'neutral'} />
        <Stat label="Cold outreach" value={settings?.coldBasisEnabled ? 'ON' : 'OFF'} caption={settings?.coldBasisEnabled ? 'owner has allowed business addresses' : 'only people with email consent'} tone={settings?.coldBasisEnabled ? 'warning' : 'success'} />
      </StatGrid>

      <Card>
        <CardHeader title="Sender and limits" description="Printed in every email and enforced on every send." />
        <CardBody>
          <SettingsForm
            isOwner={isOwner}
            initial={{
              senderName: settings?.senderName ?? '',
              postalAddress: settings?.postalAddress ?? '',
              replyTo: settings?.replyTo ?? '',
              dailyCap: settings?.dailyCap ?? 20,
              bouncePausePercent: settings?.bouncePausePercent ?? 5,
              coldBasisEnabled: settings?.coldBasisEnabled ?? false,
            }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Campaigns" description="A campaign is up to three steps of approved wording. A second person approves it; approving freezes who it goes to." />
        <CardBody className="flex flex-col gap-4">
          {campaigns.length === 0 ? (
            <EmptyState title="No campaigns yet" description="Add people and an approved template, then create one below." />
          ) : (
            <ul className="divide-y divide-line">
              {campaigns.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <Link href={`/communication/email-outreach/${c.id}`} className="font-medium underline-offset-2 hover:underline">
                    {c.name}
                  </Link>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {c.recipientCount !== null ? `${c.recipientCount} people` : 'audience not frozen yet'} · {clock.dateTime(c.createdAt)} <StatusBadge status={c.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Create a campaign</summary>
            <div className="pt-3">
              <CampaignForm templates={approved.map((t) => ({ id: t.id, name: t.name, language: t.language }))} />
            </div>
          </details>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Templates" description="Approved wording only. The database refuses prices, discounts, guarantees, AI tooling and a hand-written unsubscribe line." />
        <CardBody className="flex flex-col gap-4">
          {templates.length === 0 ? (
            <p className="text-[13px] text-muted">No templates yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {templates.map((t) => (
                <li key={t.id} className="flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {t.name} <span className="font-normal text-muted">· {t.language} · “{t.subject}”</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={t.status} />
                      {t.status === 'draft' && mayApprove ? <ApproveTemplateForm templateId={t.id} /> : null}
                    </span>
                  </div>
                  <p className="whitespace-pre-line text-xs text-muted">{t.body}</p>
                </li>
              ))}
            </ul>
          )}
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Write a template</summary>
            <div className="pt-3">
              <TemplateForm />
            </div>
          </details>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="People" description="Each with how the address was obtained and the basis it may be emailed on." />
        <CardBody className="flex flex-col gap-4">
          {prospects.rows.length === 0 ? (
            <p className="text-[13px] text-muted">No one yet.</p>
          ) : (
            <ul className="divide-y divide-line text-[13px]">
              {prospects.rows.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{p.fullName ?? p.email}</span> <span className="text-muted">{p.fullName ? p.email : ''}{p.company ? ` · ${p.company}` : ''}</span>
                    <span className="block text-xs text-faint">
                      {p.basis.replace(/_/g, ' ')} · {p.provenance}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={p.status} />
                    <ProspectActions prospectId={p.id} status={p.status} leadId={p.leadId} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Add people</summary>
            <div className="pt-3">
              <ImportForm />
            </div>
          </details>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Never email again" description="Permanent. An unsubscribe, a hard bounce, a complaint or a manual stop. Nothing removes a row from this list." />
        <CardBody className="flex flex-col gap-4">
          {suppressions.length === 0 ? (
            <p className="text-[13px] text-muted">Nobody yet.</p>
          ) : (
            <ul className="divide-y divide-line text-[13px]">
              {suppressions.map((s) => (
                <li key={s.email} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span>{s.email}</span>
                  <span className="text-xs text-muted">
                    {s.reason.replace(/_/g, ' ')} · {s.source} · {clock.dateTime(s.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {mayApprove ? <SuppressForm /> : null}
        </CardBody>
      </Card>
    </div>
  );
}
