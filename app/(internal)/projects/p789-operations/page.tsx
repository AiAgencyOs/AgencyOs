import type { Metadata } from 'next';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { P789DoorForm } from '@/modules/projects/p789-round2-form';
import { readAdminNotificationQueue, readOutageCases, readProviderRecords } from '@/modules/projects/p789-round2-queries';
import { Badge, Card, CardHeader, PageHeader, PermissionDenied, humanize } from '@/ui';

export const metadata: Metadata = { title: 'Incident notifications and provider outages' };

const SEVERITY = [['sev1', 'Severity 1'], ['sev2', 'Severity 2'], ['sev3', 'Severity 3']] as [string, string][];
const CHANNEL = [['internal_inbox', 'Internal inbox'], ['email', 'E-mail (a person relays it)'], ['whatsapp', 'WhatsApp (a person relays it)']] as [string, string][];
const PROVIDER_KIND = ['hosting', 'database', 'email', 'payment', 'whatsapp', 'ai_model', 'dns', 'other'].map((v) => [v, humanize(v)]) as [string, string][];
const DECISION = [['wait', 'Wait'], ['retry', 'Retry later'], ['failover', 'Fail over (needs independent Admin approval)'], ['escalate_to_provider', 'Escalate to the provider'], ['stop', 'Stop']] as [string, string][];
const OUTAGE_KIND = ['cloud_timeout', 'provider_outage', 'audit_store_failure', 'monitoring_gap'].map((v) => [v, humanize(v)]) as [string, string][];
const HANDLING = ['waited', 'retried', 'failed_over', 'degraded', 'work_held', 'manual_workaround'].map((v) => [v, humanize(v)]) as [string, string][];

/**
 * P7-INC-07 / INC-08 / NEG-01. The Admin notification queue (what an Admin must be told and by when), the provider-outage decisions people recorded, and the
 * outage cases. Every number and state here is a stored fact or derived from one. AgencyOS delivers no e-mail or WhatsApp, fails nothing over and contacts no
 * provider: a person does each, and records it here. Nothing on this page has been rendered or clicked in a browser by the builder.
 */
export default async function P789OperationsPage() {
  const context = await requireInternal('/projects/p789-operations');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const clock = await agencyClock();
  const [queue, records, cases] = await Promise.all([readAdminNotificationQueue(), readProviderRecords(), readOutageCases()]);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Incident notifications and provider outages" description="Who must be told, what was decided during a provider outage, and the outage cases on record." />

      <Card>
        <CardHeader title="Admin notification queue" description="Written when an incident opens, by the Admin-set policy. Only Admins see this queue. E-mail and WhatsApp are relayed by a person; the row says so." />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {queue.length === 0 ? <p className="text-[13px] text-muted">Nothing waiting, or you are not an Admin.</p> : null}
          {queue.map((n) => (
            <div key={n.id} className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={n.overdue ? 'danger' : n.status === 'pending' ? 'warning' : 'success'}>{n.status === 'pending' ? (n.overdue ? 'Overdue' : 'Pending') : 'Acknowledged'}</Badge>
                <span>{humanize(n.severity)}</span>
                <span className="text-muted">via {humanize(n.channel)}{n.delivery === 'relay_by_person_required' ? ' (a person relays it)' : ''}</span>
                <span className="text-muted">acknowledge by {clock.date(n.dueBy)}</span>
              </div>
              <p>{n.technicalSummary}</p>
              {n.status === 'pending' ? <P789DoorForm door="notification_ack" hidden={{ notificationId: n.id }} fields={[{ kind: 'text', name: 'note', label: 'Acknowledgement note' }]} submit="Acknowledge" /> : null}
              {n.status === 'pending' ? (
                <P789DoorForm
                  door="provider_decision"
                  hidden={{ incidentId: n.incidentId }}
                  intro="If this is a provider outage, record what was decided. AgencyOS fails nothing over."
                  fields={[
                    { kind: 'select', name: 'providerKind', label: 'Provider kind', options: PROVIDER_KIND },
                    { kind: 'text', name: 'providerName', label: 'Provider name', required: true },
                    { kind: 'select', name: 'decision', label: 'Decision', options: DECISION },
                    { kind: 'date', name: 'nextCheckOn', label: 'Next check (wait or retry)' },
                    { kind: 'text', name: 'failoverTarget', label: 'Fail-over target (fail-over only)' },
                    { kind: 'text', name: 'evidenceRef', label: 'Evidence (a status page, a ticket)', required: true },
                  ]}
                  submit="Record decision"
                />
              ) : null}
            </div>
          ))}
          {can(context, 'project.write') ? (
            <P789DoorForm
              door="policy_set"
              intro="Admin only. The newest version for a severity applies to the next incident."
              fields={[
                { kind: 'select', name: 'severity', label: 'Severity', options: SEVERITY },
                { kind: 'select', name: 'channel', label: 'Channel', options: CHANNEL },
                { kind: 'number', name: 'minutes', label: 'Minutes to acknowledge', placeholder: 'Minutes to acknowledge', required: true },
                { kind: 'text', name: 'reason', label: 'Reason', required: true },
              ]}
              submit="Set policy"
            />
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Provider-outage decisions" description="A fail-over is approved by an Admin other than the person who recorded it, and its execution is recorded afterwards with evidence." />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {records.length === 0 ? <p className="text-[13px] text-muted">No decision recorded.</p> : null}
          {records.map((r) => (
            <div key={r.id} className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{humanize(r.decision)}</Badge>
                <span>{r.providerName} ({humanize(r.providerKind)})</span>
                {r.failoverTarget ? <span className="text-muted">to {r.failoverTarget}</span> : null}
                {r.nextCheckAt ? <span className="text-muted">next check {clock.date(r.nextCheckAt)}</span> : null}
                {r.decision === 'failover' ? <Badge tone={r.executed ? 'success' : r.approved ? 'warning' : 'danger'}>{r.executed ? 'Executed (recorded)' : r.approved ? 'Approved, not yet recorded as executed' : 'Awaiting approval'}</Badge> : null}
              </div>
              {r.decision === 'failover' && !r.approved ? <P789DoorForm door="failover_approve" hidden={{ recordId: r.id }} fields={[{ kind: 'text', name: 'note', label: 'Approval note' }]} submit="Approve fail-over" /> : null}
              {r.decision === 'failover' && r.approved && !r.executed ? <P789DoorForm door="failover_executed" hidden={{ recordId: r.id }} fields={[{ kind: 'text', name: 'evidence', label: 'Evidence the fail-over happened' }]} submit="Record execution" /> : null}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Outage cases" description="Provider outages, cloud timeouts, monitoring gaps and audit-store failures, how they were handled, and the audit gap stated." />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {cases.length === 0 ? <p className="text-[13px] text-muted">No case recorded.</p> : null}
          {cases.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={c.status === 'open' ? 'warning' : 'success'}>{humanize(c.status)}</Badge>
                <span>{humanize(c.kind)}</span>
                <span className="text-muted">{humanize(c.handling)}, from {clock.date(c.observedFrom)}{c.observedUntil ? ` to ${clock.date(c.observedUntil)}` : ''}</span>
                {c.auditGap ? <Badge tone="danger">Audit gap</Badge> : null}
              </div>
              <p>{c.summary}</p>
              {c.status === 'open' ? (
                <P789DoorForm door="outage_resolve" hidden={{ caseId: c.id }} fields={[{ kind: 'date', name: 'observedUntilOn', label: 'Ended on', required: true }, { kind: 'text', name: 'note', label: 'Resolution note' }]} submit="Resolve" />
              ) : null}
            </div>
          ))}
          <P789DoorForm
            door="outage_record"
            fields={[
              { kind: 'select', name: 'kind', label: 'Kind', options: OUTAGE_KIND },
              { kind: 'select', name: 'handling', label: 'Handling', options: HANDLING },
              { kind: 'date', name: 'observedOn', label: 'Started on', required: true },
              { kind: 'textarea', name: 'summary', label: 'What happened', required: true },
              { kind: 'checkbox', name: 'auditGap', label: 'Audit records may be missing for this window (required for an audit-store failure)' },
            ]}
            submit="Record case"
          />
        </div>
      </Card>
    </div>
  );
}
