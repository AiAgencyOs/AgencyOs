import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  readCustomer360,
  type C360Cap,
  type C360CheckIn,
  type C360Eligibility,
  type C360Health,
  type C360Invoice,
  type C360LedgerRow,
  type C360Opportunity,
  type C360Plan,
  type C360Project,
  type C360QuietPeriod,
  type C360Recovery,
  type C360Renewal,
  type C360Ticket,
} from '@/modules/projects/customer-360-queries';
import { Badge, Callout, Card, CardHeader, DataTable, EmptyState, IconProjects, PageHeader, PermissionDenied, Stat, StatGrid, humanize, type Column, type Tone } from '@/ui';

import { DoorForm } from './customer-360-forms';

export const metadata: Metadata = { title: 'Customer 360' };

const HEALTH_TONE: Record<string, Tone> = { healthy: 'success', stable: 'info', watch: 'warning', at_risk: 'danger', critical: 'danger' };
const SLA_TONE: Record<string, Tone> = { met: 'success', running: 'info', breached: 'danger', met_late: 'warning', not_started: 'neutral', not_applicable: 'neutral' };
const day = (v: string | null) => (v ? v.slice(0, 10) : '—');
const money = (minor: number, currency: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);

const CHANNELS: [string, string][] = [['whatsapp', 'WhatsApp'], ['email', 'Email'], ['portal', 'Portal'], ['call', 'Call'], ['meeting', 'Meeting']];
const PURPOSES: [string, string][] = [['operational', 'Operational'], ['relationship', 'Relationship'], ['commercial', 'Commercial']];

const projectColumns: Column<C360Project>[] = [
  { key: 'name', header: 'Project', primary: true, cell: (p) => <Link href={`/projects/${p.id}`} className="underline">{p.name}</Link> },
  { key: 'phase', header: 'Phase', cell: (p) => p.phaseLabel },
  { key: 'status', header: 'Status', badge: true, cell: (p) => <Badge>{humanize(p.status)}</Badge> },
  { key: 'p8', header: 'Phase 8', cell: (p) => (p.phaseEight ? humanize(p.phaseEight.state) : '—') },
  { key: 'warranty', header: 'Warranty ends', cell: (p) => day(p.phaseEight?.warrantyEndsOn ?? null) },
];
const ticketColumns: Column<C360Ticket>[] = [
  { key: 'ref', header: 'Ticket', primary: true, cell: (t) => `${t.ref} ${t.title}` },
  { key: 'project', header: 'Project', cell: (t) => t.projectName },
  { key: 'status', header: 'State', badge: true, cell: (t) => <Badge tone={t.open ? 'info' : 'neutral'}>{humanize(t.status)}</Badge> },
  { key: 'priority', header: 'Priority', cell: (t) => (t.priority ? t.priority.toUpperCase() : '—') },
  { key: 'response', header: 'Response SLA', cell: (t) => <Badge tone={SLA_TONE[t.responseState] ?? 'neutral'}>{humanize(t.responseState)}</Badge> },
  { key: 'resolution', header: 'Resolution SLA', cell: (t) => <Badge tone={SLA_TONE[t.resolutionState] ?? 'neutral'}>{humanize(t.resolutionState)}</Badge> },
  { key: 'raised', header: 'Raised', cell: (t) => day(t.raisedAt) },
  { key: 'closed', header: 'Closed', cell: (t) => day(t.closedAt) },
];
const planColumns: Column<C360Plan>[] = [
  { key: 'name', header: 'Plan', primary: true, cell: (p) => `${p.name} v${p.version}` },
  { key: 'project', header: 'Project', cell: (p) => p.projectName },
  { key: 'status', header: 'State', badge: true, cell: (p) => <Badge>{humanize(p.status)}</Badge> },
  { key: 'billing', header: 'Billing', cell: (p) => humanize(p.billingModel) },
  { key: 'starts', header: 'Starts', cell: (p) => day(p.startsOn) },
  { key: 'ends', header: 'Ends', cell: (p) => day(p.endsOn) },
];
const renewalColumns: Column<C360Renewal>[] = [
  { key: 'ends', header: 'Due', primary: true, cell: (r) => day(r.endsOn) },
  { key: 'plan', header: 'Plan', cell: (r) => `${r.planName} (${r.projectName})` },
  { key: 'status', header: 'State', badge: true, cell: (r) => <Badge>{humanize(r.status)}</Badge> },
];
const recoveryColumns: Column<C360Recovery>[] = [
  { key: 'project', header: 'Project', primary: true, cell: (r) => r.projectName },
  { key: 'status', header: 'State', badge: true, cell: (r) => <Badge>{humanize(r.status)}</Badge> },
  { key: 'cause', header: 'Root cause', cell: (r) => r.rootCause ?? '—' },
  { key: 'deadline', header: 'Deadline', cell: (r) => day(r.deadline) },
  { key: 'outcome', header: 'Outcome', cell: (r) => r.outcome ?? '—' },
];
const checkInColumns: Column<C360CheckIn>[] = [
  { key: 'kind', header: 'Check-in', primary: true, cell: (c) => humanize(c.kind) },
  { key: 'project', header: 'Project', cell: (c) => c.projectName },
  { key: 'status', header: 'State', badge: true, cell: (c) => <Badge>{humanize(c.status)}</Badge> },
  { key: 'due', header: 'Due', cell: (c) => day(c.dueOn) },
  { key: 'engagement', header: 'Engagement', cell: (c) => humanize(c.engagement) },
  { key: 'outcome', header: 'Outcome', cell: (c) => c.outcome ?? '—' },
];
const opportunityColumns: Column<C360Opportunity>[] = [
  { key: 'need', header: 'Need', primary: true, cell: (o) => o.need },
  { key: 'project', header: 'Project', cell: (o) => o.projectName },
  { key: 'kind', header: 'Kind', cell: (o) => humanize(o.kind) },
  { key: 'status', header: 'Stage', badge: true, cell: (o) => <Badge tone={o.status === 'suppressed' ? 'warning' : 'neutral'}>{humanize(o.status)}</Badge> },
  { key: 'held', header: 'Held because', cell: (o) => o.suppressedReason ?? '—' },
];
const invoiceColumns: Column<C360Invoice>[] = [
  { key: 'number', header: 'Invoice', primary: true, cell: (i) => <Link href={`/invoices/${i.id}`} className="underline">{i.number}</Link> },
  { key: 'status', header: 'State', badge: true, cell: (i) => <Badge tone={i.status === 'overdue' ? 'danger' : 'neutral'}>{humanize(i.status)}</Badge> },
  { key: 'total', header: 'Total', align: 'right', cell: (i) => money(i.totalMinor, i.currency) },
  { key: 'verified', header: 'Verified received', align: 'right', cell: (i) => money(i.verifiedMinor, i.currency) },
  { key: 'outstanding', header: 'Outstanding', align: 'right', cell: (i) => (i.live ? money(i.outstandingMinor, i.currency) : '—') },
  { key: 'due', header: 'Due', cell: (i) => day(i.dueAt) },
];
const eligibilityColumns: Column<C360Eligibility>[] = [
  { key: 'channel', header: 'Channel', primary: true, cell: (e) => `${humanize(e.channel)} (${e.purpose})` },
  { key: 'allowed', header: 'Contact now?', badge: true, cell: (e) => <Badge tone={e.allowed ? 'success' : 'danger'}>{e.allowed ? 'Allowed' : 'Not allowed'}</Badge> },
  { key: 'reasons', header: 'Why not', cell: (e) => (e.reasons.length > 0 ? e.reasons.join('; ') : '—') },
];
const capColumns: Column<C360Cap>[] = [
  { key: 'channel', header: 'Channel', primary: true, cell: (c) => (c.channel ? humanize(c.channel) : 'Every channel') },
  { key: 'cap', header: 'Cap', cell: (c) => `${c.maxContacts} in ${c.windowDays} days` },
  { key: 'active', header: 'State', badge: true, cell: (c) => <Badge tone={c.active ? 'info' : 'neutral'}>{c.active ? 'Active' : 'Cleared'}</Badge> },
];
const quietColumns: Column<C360QuietPeriod>[] = [
  { key: 'period', header: 'Quiet period (UTC)', primary: true, cell: (q) => `${q.startsAt.slice(0, 16).replace('T', ' ')} to ${q.endsAt.slice(0, 16).replace('T', ' ')}` },
  { key: 'reason', header: 'Reason', cell: (q) => q.reason },
  { key: 'state', header: 'State', badge: true, cell: (q) => <Badge tone={q.cancelledAt ? 'neutral' : 'warning'}>{q.cancelledAt ? 'Cancelled' : 'Set'}</Badge> },
];
const ledgerColumns: Column<C360LedgerRow>[] = [
  { key: 'when', header: 'When (UTC)', primary: true, cell: (l) => l.occurredAt.slice(0, 16).replace('T', ' ') },
  { key: 'kind', header: 'Entry', badge: true, cell: (l) => <Badge tone={l.entryKind === 'sent_by_person' ? 'info' : 'neutral'}>{l.entryKind === 'sent_by_person' ? 'Sent by a person' : `Drafted by ${l.draftedByAgent ?? 'an agent'}`}</Badge> },
  { key: 'channel', header: 'Channel', cell: (l) => `${humanize(l.channel)} (${l.purpose})` },
  { key: 'summary', header: 'What', cell: (l) => l.summary },
  { key: 'delivery', header: 'Delivery', cell: (l) => `${humanize(l.deliveryState)}${l.deliverySource === 'none' ? '' : ` (${humanize(l.deliverySource)})`}${l.replied ? ', replied' : ''}` },
  { key: 'eligible', header: 'Eligible when recorded', cell: (l) => (l.eligibleAtRecord === null ? '—' : l.eligibleAtRecord ? 'Yes' : `No: ${l.eligibilityReasons.join('; ')}`) },
];

/**
 * Customer 360 (Phase 8 P8-ADM-001): one client across all of its projects, for internal staff. Everything shown is read as stored or from the database
 * function that derives it (health, SLA state, eligibility); this page computes and stores nothing. Finance is shown only to a viewer who may read it.
 * Nothing on this page sends anything to the client: the ledger is a person's record, a value report is a draft.
 */
export default async function Customer360Page({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const context = await requireInternal(`/clients/${clientId}/customer-360`);
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const mayWrite = can(context, 'project.write');
  const mayReadFinance = can(context, 'invoice.read');

  const view = await readCustomer360(clientId, { mayReadFinance });
  if (!view) notFound();

  const openTickets = view.tickets.filter((t) => t.open);
  const worst = (['critical', 'at_risk', 'watch', 'stable', 'healthy'] as const).find((s) => view.health.some((h) => h.status === s));
  const ledgerEntries = view.ledger.filter((l) => l.entryKind === 'sent_by_person');
  const activeCaps = view.caps.filter((c) => c.active);
  const drafts = view.valueReports.filter((r) => r.status === 'draft');
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${view.client.name}: Customer 360`}
        description="One client across every project: where each stands, service and health, the maintenance plan and its renewal, money, and how and when we may contact them."
        actions={<Link href={`/clients/${view.client.id}`} className="text-[13px] underline">Back to the client</Link>}
      />

      <StatGrid>
        <Stat label="Projects" value={view.projects.length} caption={`${view.projects.filter((p) => p.phaseEight !== null).length} in customer success`} icon={<IconProjects size={16} />} />
        <Stat label="Open tickets" value={openTickets.length} caption={`${openTickets.filter((t) => t.resolutionState === 'breached' || t.responseState === 'breached').length} past an SLA target`} tone={openTickets.length > 0 ? 'warning' : 'neutral'} />
        <Stat label="Health (derived)" value={worst ? humanize(worst) : '—'} caption={worst ? 'worst across live projects' : 'no live customer-success project'} tone={worst ? HEALTH_TONE[worst] : 'neutral'} />
        {view.outstandingByCurrency ? (
          <Stat
            label="Outstanding (verified basis)"
            value={view.outstandingByCurrency.length > 0 ? view.outstandingByCurrency.map((o) => money(o.outstandingMinor, o.currency)).join(' + ') : money(0, view.client.currency)}
            caption="live invoices less verified money"
          />
        ) : null}
      </StatGrid>

      <Card>
        <CardHeader title="Projects" description="Where each project stands, from the phase records." />
        {view.projects.length > 0 ? <DataTable dense rows={view.projects} columns={projectColumns} getKey={(p) => p.id} /> : <EmptyState title="No projects" description="This client has no project yet." />}
      </Card>

      <Card>
        <CardHeader title="Health" description="Derived on every read from tickets, SLA stamps, invoices, defects and plans. Nothing is stored or scored." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {view.health.length === 0 ? <p className="text-[13px] text-muted">No project of this client is in customer success yet.</p> : null}
          {view.health.map((h: C360Health) => (
            <div key={h.projectId} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-[13px]">
                <Badge tone={HEALTH_TONE[h.status] ?? 'neutral'}>{humanize(h.status)}</Badge>
                <span>{h.projectName}</span>
              </div>
              <ul className="ml-1 list-disc pl-5 text-[13px] text-muted">
                {h.signals.filter((s) => s.level !== 'ok').map((s) => (
                  <li key={s.signal}>{humanize(s.signal)}: {s.detail}</li>
                ))}
                {h.signals.every((s) => s.level === 'ok') ? <li>No signal is above normal.</li> : null}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Support tickets" description="Open first. SLA state is read from the support clock, not computed here." />
        {view.tickets.length > 0 ? <DataTable dense rows={view.tickets} columns={ticketColumns} getKey={(t) => t.id} /> : <EmptyState title="No tickets" description="No support ticket has been raised for this client." />}
      </Card>

      <Card>
        <CardHeader title="Maintenance plans and renewals" description="A renewal is flagged and reviewed by a person; nothing renews itself." />
        {view.plans.length > 0 ? <DataTable dense rows={view.plans} columns={planColumns} getKey={(p) => p.id} /> : <EmptyState title="No maintenance plan" description="No maintenance plan version exists for this client's projects." />}
        {view.renewals.length > 0 ? (
          <div className="px-4 pb-4 pt-2 sm:px-5">
            <p className="mb-1 text-[13px] font-medium">Renewal due dates</p>
            <DataTable dense rows={view.renewals} columns={renewalColumns} getKey={(r) => r.planId} />
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Recovery plans, check-ins and expansion" />
        <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
          <div>
            <p className="mb-1 text-[13px] font-medium">Recovery plans</p>
            {view.recovery.length > 0 ? <DataTable dense rows={view.recovery} columns={recoveryColumns} getKey={(r) => r.id} /> : <p className="text-[13px] text-muted">None.</p>}
          </div>
          <div>
            <p className="mb-1 text-[13px] font-medium">Check-ins</p>
            {view.checkIns.length > 0 ? <DataTable dense rows={view.checkIns} columns={checkInColumns} getKey={(c) => c.id} /> : <p className="text-[13px] text-muted">None.</p>}
          </div>
          <div>
            <p className="mb-1 text-[13px] font-medium">Expansion opportunities</p>
            {view.opportunities.length > 0 ? <DataTable dense rows={view.opportunities} columns={opportunityColumns} getKey={(o) => o.id} /> : <p className="text-[13px] text-muted">None. Nothing here is priced: quoting happens in the sales quotation steps.</p>}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Invoices and money" description="Verified money only: recorded-but-unverified payments are not counted as received." />
        {view.invoices === null ? (
          <div className="px-4 pb-4 sm:px-5">
            <Callout tone="info">Your role cannot read finance, so invoices and amounts are not shown on this page.</Callout>
          </div>
        ) : view.invoices.length > 0 ? (
          <DataTable dense rows={view.invoices} columns={invoiceColumns} getKey={(i) => i.id} />
        ) : (
          <EmptyState title="No invoices" description="No invoice exists for this client." />
        )}
      </Card>

      <Card>
        <CardHeader title="May we contact them now?" description="Answered by the database from consent, quiet periods, caps and the customer-success rules. AgencyOS sends nothing: this is the check to make first." />
        <DataTable dense rows={view.eligibility} columns={eligibilityColumns} getKey={(e) => `${e.channel}:${e.purpose}`} />
        <div className="grid gap-4 px-4 pb-4 pt-3 sm:px-5 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium">Contact caps (Admin-set; no cap exists until one is set)</p>
            {view.caps.length > 0 ? <DataTable dense rows={view.caps} columns={capColumns} getKey={(c) => c.id} /> : <p className="text-[13px] text-muted">No cap is set for this client.</p>}
            {mayWrite ? (
              <>
                <DoorForm door="set_cap" clientId={view.client.id} intro="Admins only. At most this many person-sent contacts inside the window." submit="Set cap"
                  fields={[{ kind: 'select', name: 'channel', label: 'Channel', options: [['all', 'Every channel'], ...CHANNELS] }, { kind: 'number', name: 'maxContacts', label: 'Contacts', required: true }, { kind: 'number', name: 'windowDays', label: 'Window in days', required: true }]} />
                {activeCaps.length > 0 ? <DoorForm door="clear_cap" clientId={view.client.id} intro="Admins only." submit="Clear this cap" fields={[{ kind: 'select', name: 'channel', label: 'Channel', options: [['all', 'Every channel'], ...CHANNELS] }]} /> : null}
              </>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium">Quiet periods (Admin-set)</p>
            {view.quietPeriods.length > 0 ? <DataTable dense rows={view.quietPeriods} columns={quietColumns} getKey={(q) => q.id} /> : <p className="text-[13px] text-muted">No quiet period is set.</p>}
            {mayWrite ? (
              <>
                <DoorForm door="add_quiet" clientId={view.client.id} intro="Admins only. Times are UTC." submit="Add quiet period"
                  fields={[{ kind: 'datetime-local', name: 'startsAt', label: 'Starts (UTC)', required: true }, { kind: 'datetime-local', name: 'endsAt', label: 'Ends (UTC)', required: true }, { kind: 'text', name: 'reason', label: 'Reason', required: true }]} />
                {view.quietPeriods.filter((q) => !q.cancelledAt).map((q) => (
                  <DoorForm key={q.id} door="cancel_quiet" clientId={view.client.id} hidden={{ quietPeriodId: q.id }} intro={`Admins only. Cancel the period ending ${q.endsAt.slice(0, 10)}.`} submit="Cancel it" fields={[{ kind: 'text', name: 'reason', label: 'Why', required: true }]} />
                ))}
              </>
            ) : null}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Communication ledger" description="What a person sent, and what an agent drafted (a draft is never a contact). Append-only. Delivery comes from a person's note or the outbound message log." />
        {view.ledger.length > 0 ? <DataTable dense rows={view.ledger} columns={ledgerColumns} getKey={(l) => l.id} /> : <EmptyState title="Nothing recorded" description="No contact has been recorded for this client." />}
        {mayWrite ? (
          <div className="grid gap-4 px-4 pb-4 pt-3 sm:px-5 lg:grid-cols-2">
            <DoorForm door="record_contact" clientId={view.client.id} intro="Record what you sent or said. This does not send anything; if the check above said no, it is still recorded, with that answer beside it." submit="Record a contact"
              fields={[
                { kind: 'select', name: 'channel', label: 'Channel', options: CHANNELS },
                { kind: 'select', name: 'purpose', label: 'Purpose', options: PURPOSES, defaultValue: 'relationship' },
                { kind: 'select', name: 'contactId', label: 'Contact', options: [['', 'Whole account'], ...view.contacts.map((c): [string, string] => [c.id, `${c.name} (WhatsApp consent: ${c.whatsappConsent})`])] },
                { kind: 'select', name: 'projectId', label: 'Project', options: [['', 'Not about one project'], ...view.projects.map((p): [string, string] => [p.id, p.name])] },
                { kind: 'textarea', name: 'summary', label: 'What was sent or said', required: true },
                { kind: 'datetime-local', name: 'occurredAt', label: 'When (UTC, blank = now)' },
                { kind: 'text', name: 'externalRef', label: 'Provider reference (optional, prevents a duplicate)' },
              ]} />
            {ledgerEntries.length > 0 ? (
              <DoorForm door="record_event" clientId={view.client.id} intro="Record what you learned about a contact you made: delivered, read, failed, bounced or replied." submit="Record"
                fields={[
                  { kind: 'select', name: 'ledgerId', label: 'Entry', options: ledgerEntries.map((l): [string, string] => [l.id, `${l.occurredAt.slice(0, 10)} ${humanize(l.channel)}: ${l.summary.slice(0, 50)}`]) },
                  { kind: 'select', name: 'event', label: 'What happened', options: [['delivered', 'Delivered'], ['read', 'Read'], ['failed', 'Failed'], ['bounced', 'Bounced'], ['replied', 'Replied']] },
                  { kind: 'text', name: 'note', label: 'Note (optional)' },
                ]} />
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Value reports (drafts)" description="Facts only, each citing the record it came from. A person edits and approves; nothing is sent. No uptime figure, score or saving is ever stated." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {view.valueReports.length === 0 ? <p className="text-[13px] text-muted">No report has been drafted for this client.</p> : null}
          {view.valueReports.map((r) => (
            <div key={r.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <Badge tone={r.status === 'approved' ? 'success' : r.status === 'discarded' ? 'neutral' : 'warning'}>{humanize(r.status)}</Badge>
                <span>{r.periodStart} to {r.periodEnd}</span>
                <span className="text-muted">template v{r.templateVersion}, {r.factCount} cited fact{r.factCount === 1 ? '' : 's'}{r.builtByAgent ? `, drafted by ${r.builtByAgent}` : ''}</span>
              </div>
              <pre className="whitespace-pre-wrap rounded bg-surface-muted p-2 text-[13px]">{r.body}</pre>
              {r.status === 'draft' && mayWrite ? (
                <div className="grid gap-3 lg:grid-cols-3">
                  <DoorForm door="report_edit" clientId={view.client.id} hidden={{ reportId: r.id }} submit="Save wording" fields={[{ kind: 'textarea', name: 'body', label: 'Wording', defaultValue: r.body, required: true }]} />
                  <DoorForm door="report_approve" clientId={view.client.id} hidden={{ reportId: r.id }} intro="Approve the wording you stand behind. This does not send it." submit="Approve" />
                  <DoorForm door="report_discard" clientId={view.client.id} hidden={{ reportId: r.id }} submit="Discard" fields={[{ kind: 'text', name: 'reason', label: 'Why', required: true }]} />
                </div>
              ) : null}
            </div>
          ))}
          {mayWrite ? (
            <DoorForm door="report_store" clientId={view.client.id} tone="primary" intro={drafts.length > 0 ? 'Build another draft from the recorded facts of a period.' : 'Build a draft from the recorded facts of a period.'} submit="Build the draft"
              fields={[{ kind: 'date', name: 'periodStart', label: 'From', required: true, defaultValue: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) }, { kind: 'date', name: 'periodEnd', label: 'To', required: true, defaultValue: today }]} />
          ) : null}
        </div>
      </Card>
    </div>
  );
}
