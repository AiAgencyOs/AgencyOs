import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { P789DoorForm } from '@/modules/projects/p789-round2-form';
import { readAcknowledgedDeveloperRequests, readAlerts, readFeedbackSignalDrafts, readRetentionDecisions } from '@/modules/projects/p789-round2-queries';
import { Badge, Card, CardHeader, PageHeader, PermissionDenied, humanize } from '@/ui';

export const metadata: Metadata = { title: 'Customer Success governance' };

const DATA_SETS = ['communication_ledger', 'client_feedback', 'value_reports', 'opportunities', 'access_denials'].map((v) => [v, humanize(v)]) as [string, string][];
const METRICS = [['tickets_sla_breached', 'Tickets past their SLA'], ['check_ins_overdue', 'Overdue check-ins'], ['recovery_plans_open', 'Open recovery plans'], ['admin_notifications_overdue', 'Overdue Admin notifications']] as [string, string][];

/**
 * Retention decisions for the Phase 8 data sets the Phase 7 class list does not cover, alert rules and alerts, feedback-signal drafts waiting for a person, and
 * acknowledged developer requests that can become a task. A decision here deletes nothing and an alert sends nothing: they are records for a person. Nothing on
 * this page has been rendered or clicked in a browser by the builder.
 */
export default async function P789GovernancePage() {
  const context = await requireInternal('/projects/customer-success/p789-governance');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const clock = await agencyClock();
  const [retention, alerts, drafts, requests] = await Promise.all([readRetentionDecisions(), readAlerts(), readFeedbackSignalDrafts(), readAcknowledgedDeveloperRequests()]);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Customer Success governance" description="Retention decisions, alerts, feedback signals and follow-up tasks. Records for a person; nothing here is sent or deleted." actions={<Link href="/projects/customer-success/p789-charts" className="text-[13px] underline">Charts</Link>} />

      <Card>
        <CardHeader title="Retention decisions" description="An Admin's decision per data set. It is a decision, not an executor: no delete surface exists." />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {retention.map((r) => (
            <div key={r.dataSet} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-3 text-[13px]">
              <span className="font-medium">{humanize(r.dataSet)}</span>
              <Badge tone={r.decided ? 'success' : 'warning'}>{r.decided ? (r.indefinite ? 'Kept indefinitely' : `Review after ${r.retentionDays} days`) : 'No decision yet'}</Badge>
              <span className="text-muted">{r.rowsHeld} held{r.oldestAt ? `, oldest ${clock.date(r.oldestAt)}` : ''}{r.rowsPastDecision > 0 ? `, ${r.rowsPastDecision} past the decision` : ''}</span>
            </div>
          ))}
          <P789DoorForm
            door="retention_set"
            intro="Admin only."
            fields={[
              { kind: 'select', name: 'dataSet', label: 'Data set', options: DATA_SETS },
              { kind: 'select', name: 'mode', label: 'Mode', options: [['period', 'Review after a period'], ['indefinite', 'Keep indefinitely']] },
              { kind: 'number', name: 'days', label: 'Days (period only)', placeholder: 'Days (period only)' },
              { kind: 'textarea', name: 'basis', label: 'Basis for the decision', required: true },
            ]}
            submit="Record decision"
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Alerts" description="Raised when a figure reaches an Admin-set threshold; cleared by the sweep when it falls back. Nothing is sent." />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {alerts.length === 0 ? <p className="text-[13px] text-muted">No alert has been raised.</p> : null}
          {alerts.map((a) => (
            <div key={a.id} className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={a.state === 'open' ? 'danger' : a.state === 'acknowledged' ? 'warning' : 'neutral'}>{humanize(a.state)}</Badge>
                <span>{humanize(a.metric)}: {a.observed} (threshold {a.threshold})</span>
                <span className="text-muted">raised {clock.date(a.raisedAt)}{a.clearedAt ? `, cleared ${clock.date(a.clearedAt)}` : ''}</span>
              </div>
              {a.state === 'open' ? <P789DoorForm door="alert_ack" hidden={{ alertId: a.id }} fields={[{ kind: 'text', name: 'note', label: 'Acknowledgement note' }]} submit="Acknowledge" /> : null}
            </div>
          ))}
          <P789DoorForm door="alert_sweep" intro="Admin only. Compares each figure with its rule now." submit="Check the figures now" />
          <P789DoorForm
            door="alert_rule_set"
            intro="Admin only."
            fields={[{ kind: 'select', name: 'metric', label: 'Figure', options: METRICS }, { kind: 'number', name: 'threshold', label: 'Alert at or above', placeholder: 'Alert at or above', required: true }, { kind: 'text', name: 'reason', label: 'Reason', required: true }]}
            submit="Set rule"
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Feedback signals waiting for a person" description="Drafts by the Customer Success agent, each citing the feedback it read. Reviewing sends nothing." />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {drafts.length === 0 ? <p className="text-[13px] text-muted">No draft.</p> : null}
          {drafts.map((d) => (
            <div key={d.id} className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={d.status === 'draft' ? 'warning' : 'neutral'}>{humanize(d.status)}</Badge>
                <span>{humanize(d.signal)}</span>
                <span className="text-muted">cites {d.citedCount} feedback row{d.citedCount === 1 ? '' : 's'}</span>
              </div>
              <p>{d.summary}</p>
              {d.status === 'draft' ? (
                <P789DoorForm door="signal_review" hidden={{ draftId: d.id }} fields={[{ kind: 'select', name: 'decision', label: 'Decision', options: [['reviewed', 'Reviewed'], ['dismissed', 'Dismissed']] }, { kind: 'text', name: 'note', label: 'Note', required: true }]} submit="Settle" />
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Developer requests ready to become a task" description="A person acknowledged these. Making the task is a person's act; the task is built from the ticket." />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {requests.length === 0 ? <p className="text-[13px] text-muted">None waiting.</p> : null}
          {requests.map((q) => (
            <div key={q.requestId} className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
              <p>{q.reason}</p>
              <P789DoorForm door="followup_task" hidden={{ requestId: q.requestId }} fields={[{ kind: 'date', name: 'dueOn', label: 'Due on (optional)' }]} submit="Create the task" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
