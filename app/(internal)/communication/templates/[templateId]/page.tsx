import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getTemplateDetail } from '@/modules/crm/template-detail-queries';
import { TEMPLATE_PARAMETER_LABELS, type TemplateParameter } from '@/modules/crm/template-parameters';
import { Badge, Card, CardBody, CardHeader, DataTable, DetailFields, EmptyState, humanize, IconArrowLeft, PageHeader, PermissionDenied, Stat, StatGrid, StatusBadge } from '@/ui';

export const metadata: Metadata = { title: 'Template' };

/**
 * SCR-059 "Template detail" — one WhatsApp template: Meta's status and the
 * Admin's switch, the facts it fills, how it performed, every recorded
 * change and the campaigns that carried it. Read-only; the registry doors
 * stay on Settings › Communication, linked from here. `lead.read`, the
 * Communication Center's own gate.
 */
export default async function TemplateDetailPage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  const context = await requireInternal(`/communication/templates/${templateId}`);
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;
  if (!/^[0-9a-f-]{36}$/i.test(templateId)) notFound();

  const [template, clock] = await Promise.all([getTemplateDetail(templateId), agencyClock()]);
  if (!template) notFound();

  const perf = template.performance;
  const deliveryRate = perf && perf.sent > 0 ? Math.round((perf.delivered / perf.sent) * 100) : null;
  const readRate = perf && perf.delivered > 0 ? Math.round((perf.read / perf.delivered) * 100) : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={
          <Link href="/communication" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-foreground">
            <IconArrowLeft size={12} /> Communication
          </Link>
        }
        title={template.templateName}
        meta={
          <span className="flex items-center gap-1.5">
            <StatusBadge status={template.status} dot={false} />
            {!template.active ? <Badge tone="neutral">inactive</Badge> : <Badge tone="success">active</Badge>}
          </span>
        }
        description={`${humanize(template.situationKey)} · ${template.languageCode}. Meta's status is "${template.status}"; the switch is the Admin's. A send needs both.`}
        actions={can(context.role, 'organization.settings') ? <Link href="/settings/communication" className="text-[13px] font-medium text-brand hover:underline">Manage on Settings</Link> : null}
      />

      <StatGrid cols={5}>
        <Stat label="Sent" value={String(perf?.sent ?? 0)} caption="Messages carrying this template" tone="brand" />
        <Stat label="Delivered" value={String(perf?.delivered ?? 0)} caption={deliveryRate === null ? 'No sends yet' : `${deliveryRate}% of sent`} tone="success" />
        <Stat label="Read" value={String(perf?.read ?? 0)} caption={readRate === null ? '—' : `${readRate}% of delivered`} tone="info" />
        <Stat label="Replied" value={String(perf?.replied ?? 0)} caption="A reply within the thread" tone="accent" />
        <Stat label="Failed" value={String(perf?.failed ?? 0)} caption="The provider refused" tone={(perf?.failed ?? 0) > 0 ? 'danger' : 'neutral'} />
      </StatGrid>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="The template" />
          <CardBody>
            <DetailFields
              rows={[
                { label: 'Name at Meta', value: <code className="text-xs">{template.templateName}</code> },
                { label: 'Situation', value: humanize(template.situationKey) },
                { label: 'Language', value: template.languageCode },
                { label: 'Meta status', value: <StatusBadge status={template.status} dot={false} /> },
                { label: 'Admin switch', value: template.active ? 'active' : 'inactive' },
                {
                  label: 'Fills',
                  value:
                    template.parameters.length === 0
                      ? 'No variables'
                      : template.parameters.map((p) => TEMPLATE_PARAMETER_LABELS[p as TemplateParameter] ?? p).join(', '),
                },
                { label: 'Registered', value: clock.dateTime(template.createdAt) },
                { label: 'Last changed', value: clock.dateTime(template.updatedAt) },
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={`Campaigns (${template.campaigns.length})`} description="Every campaign planned with this template." />
          {template.campaigns.length === 0 ? (
            <CardBody>
              <EmptyState title="No campaign yet" description="A campaign picks an approved, active template under Communication › Campaigns." />
            </CardBody>
          ) : (
            <DataTable
              rows={template.campaigns}
              dense
              columns={[
                { key: 'name', header: 'Campaign', primary: true, cell: (c) => c.name },
                { key: 'status', header: 'Status', badge: true, cell: (c) => <StatusBadge status={c.status} /> },
                { key: 'sent', header: 'Sent', align: 'right', cellClassName: 'tabular text-muted', cell: (c) => `${c.sent} / ${c.recipients}` },
                { key: 'created', header: 'Created', align: 'right', cellClassName: 'text-muted', cell: (c) => clock.date(c.createdAt) },
              ]}
              getKey={(c) => c.id}
              href={(c) => `/communication/campaigns/${c.id}`}
            />
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title={`History (${template.versions.length})`} description="Every recorded change to this template, newest first — status, switch and variables as they were." />
        {template.versions.length === 0 ? (
          <CardBody>
            <p className="text-[13px] text-muted">No change recorded yet.</p>
          </CardBody>
        ) : (
          <DataTable
            rows={template.versions}
            dense
            columns={[
              { key: 'when', header: 'Recorded', primary: true, cell: (v) => clock.dateTime(v.recordedAt) },
              { key: 'status', header: 'Meta status', badge: true, cell: (v) => <StatusBadge status={v.status} dot={false} /> },
              { key: 'active', header: 'Switch', cellClassName: 'text-muted', cell: (v) => (v.active ? 'active' : 'inactive') },
              { key: 'params', header: 'Variables', desktopOnly: true, cellClassName: 'text-muted', cell: (v) => (v.parameters.length > 0 ? v.parameters.join(', ') : '—') },
              { key: 'reason', header: 'Reason', cellClassName: 'text-muted', cell: (v) => v.changeReason ?? '—' },
            ]}
            getKey={(v) => v.id}
          />
        )}
      </Card>
    </div>
  );
}
