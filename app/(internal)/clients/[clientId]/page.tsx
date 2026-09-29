import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { readClientCommercialTimeline, type CommercialEvent } from '@/lib/admin/client-commercials';
import { listClientMeetingNotes, readClientUnreadReplies } from '@/lib/admin/client-communication';
import { readClientNextFollowUp } from '@/lib/admin/client-followups';
import { listClientLeads, listClientOpportunities } from '@/lib/admin/client-leads';
import { getClient } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listEligibleMilestones } from '@/modules/finance/eligible-milestones-queries';
import {
  ActivityFeed,
  Callout,
  cx,
  Avatar,
  Badge,
  buttonClass,
  Card,
  CardHeader,
  DataTable,
  DetailPanel,
  EmptyState,
  EntityHeader,
  humanize,
  IconAlert,
  IconCalendar,
  IconCheck,
  IconClock,
  IconFile,
  IconInbox,
  IconInvoices,
  IconLeads,
  IconMessage,
  IconPlus,
  IconProjects,
  IconUser,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  ViewAll,
  type ActivityItem,
  type Column,
  type Tone,
} from '@/ui';

import { TrailLabel } from '../../trail-label';
import { GenerateClientInvoiceButton } from './client-forms';
import { ClientCreateButtons } from './create-buttons';
import { AddClientNoteForm } from './note-form';

const TABS = ['overview', 'projects', 'quotations', 'invoices', 'communication', 'files', 'notes', 'activity'] as const;
type Tab = (typeof TABS)[number];

function tabOf(value: string | undefined): Tab {
  return (TABS as readonly string[]).includes(value ?? '') ? (value as Tab) : 'overview';
}

const EVENT_TONE: Record<CommercialEvent['kind'], Tone> = { quotation: 'info', milestone: 'brand', invoice: 'warning', payment: 'success' };
const EVENT_ICON: Record<CommercialEvent['kind'], React.ReactNode> = {
  quotation: <IconLeads size={13} />,
  milestone: <IconCheck size={13} />,
  invoice: <IconInvoices size={13} />,
  payment: <IconCheck size={13} />,
};

/** A milestone's `due_on` is a day, not an instant; everything else on the timeline is an instant. */
function eventWhen(clock: AgencyClock, at: string | null): string {
  if (!at) return 'undated';
  return at.length === 10 ? clock.date(`${at}T00:00:00`) : clock.dateTime(at);
}

function commercialItems(events: CommercialEvent[], clock: AgencyClock): ActivityItem[] {
  return events.map((e) => ({
    id: e.id,
    title: e.title,
    detail: [e.detail, e.amountMinor !== null ? money(e.amountMinor, e.currency) : null, e.projectName].filter(Boolean).join(' · '),
    when: eventWhen(clock, e.at),
    tone: EVENT_TONE[e.kind],
    icon: EVENT_ICON[e.kind],
    ...(e.href ? { href: e.href } : {}),
  }));
}

export const metadata: Metadata = { title: 'Client' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

/**
 * Client 360 — SCR-015/016/017, laid out as the reference's client overview:
 * the identity header, six figures, the projects and invoices tables with
 * notes and files beneath, and a rail with the account details, the
 * communication threads and a timeline of what has happened.
 *
 * Every table links out to the real project/invoice pages rather than
 * duplicating their forms. Communication is each project's own
 * `project_group` WhatsApp thread (`crm.conversations`, `project_id` not
 * `lead_id`) — deliberately not the client's pre-conversion lead history,
 * because a project group has no `lead_id` at all (`conversations_kind_shape`).
 */
export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { clientId } = await params;
  const { tab: rawTab } = await searchParams;
  const tab = tabOf(rawTab);

  const context = await requireInternal(`/clients/${clientId}`);
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const client = await getClient(clientId);
  if (!client) notFound();

  // SCR-015/016/017's additions, each from its own reader: the client's
  // leads (for the follow-up and meeting notes), the next follow-up, unread
  // replies, meeting notes, the commercial timeline and the milestone each
  // project could be invoiced for next.
  const leads = await listClientLeads(clientId);
  const leadIds = leads.map((l) => l.id);
  const projectIds = client.projects.map((p) => p.id);
  const [nextFollowUp, unread, meetingNotes, commercialEvents, eligible, opportunities] = await Promise.all([
    readClientNextFollowUp(clientId, leads),
    readClientUnreadReplies({ projectIds, leadIds }),
    listClientMeetingNotes(leadIds),
    readClientCommercialTimeline({ clientAccountId: clientId, projects: client.projects }),
    listEligibleMilestones(projectIds),
    listClientOpportunities(clientId),
  ]);
  const mayInvoice = can(context.role, 'invoice.create');
  const base = `/clients/${clientId}`;
  const tabHref = (t: Tab) => (t === 'overview' ? base : `${base}?tab=${t}`);
  const invoiceTarget = eligible.find((e) => e.eligible)?.projectId ?? null;
  const commercialFeed = commercialItems(commercialEvents, clock);
  const followUpOverdue = nextFollowUp !== null && nextFollowUp.at < new Date().toISOString();

  const canWriteNotes = can(context.role, 'project.write');
  const canSeeMoney = can(context.role, 'invoice.read');
  const collection = client.invoicedMinor > 0 ? Math.round((client.paidMinor / client.invoicedMinor) * 100) : null;
  const overdue = client.invoices.filter((i) => i.status === 'overdue').length;
  const pending = client.invoices.filter((i) => i.status === 'issued' || i.status === 'overdue' || i.status === 'partially_paid').length;
  const healthy = overdue === 0 && client.status === 'active';
  const monthsSince = Math.max(0, Math.floor((Date.now() - new Date(client.createdAt).getTime()) / (30 * 86_400_000)));

  type ProjectRow = (typeof client.projects)[number];
  const projectColumns: Column<ProjectRow>[] = [
    {
      key: 'name',
      header: 'Project name',
      primary: true,
      cell: (p) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={p.name} size="sm" square tone="neutral" className="bg-sidebar-bg text-sidebar-fg ring-0" />
          <span className="truncate">{p.name}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', badge: true, cell: (p) => <StatusBadge status={p.status} dot={false} /> },
    {
      key: 'budget',
      header: 'Budget',
      align: 'right',
      cellClassName: 'tabular',
      cell: (p) => (p.budgetMinor === null ? '—' : money(p.budgetMinor, p.currency)),
    },
  ];

  type InvoiceRow = (typeof client.invoices)[number];
  const invoiceColumns: Column<InvoiceRow>[] = [
    { key: 'number', header: 'Invoice no.', primary: true, cellClassName: 'font-mono text-xs', cell: (i) => i.number },
    { key: 'status', header: 'Status', badge: true, cell: (i) => <StatusBadge status={i.status} dot={false} /> },
    { key: 'total', header: 'Amount', align: 'right', cellClassName: 'tabular', cell: (i) => money(i.totalMinor, i.currency) },
    {
      key: 'paid',
      header: 'Paid',
      width: '9rem',
      cell: (i) => <ProgressBar value={i.totalMinor > 0 ? (i.paidMinor / i.totalMinor) * 100 : 0} label={`${i.number} paid`} size="sm" />,
    },
  ];

  const timeline: ActivityItem[] = [
    { id: 'created', at: client.createdAt, title: 'Client account created', tone: 'success' as const, icon: <IconCheck size={13} /> },
    ...client.notes.map((n) => ({ id: `note-${n.id}`, at: n.createdAt, title: 'Note added', detail: n.body, tone: 'info' as const, icon: <IconMessage size={13} /> })),
    ...client.quotations.map((qn) => ({ id: `q-${qn.id}`, at: qn.createdAt, title: `Quotation v${qn.version} ${humanize(qn.status)}`, detail: `${qn.title} · ${money(qn.totalMinor, qn.currency)}`, tone: 'brand' as const, icon: <IconInvoices size={13} /> })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 6)
    .map(({ at, ...rest }) => ({ ...rest, when: clock.date(at) }));

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name={client.name} />
      <EntityHeader
        name={client.name}
        tile={<Avatar name={client.name} size="xl" />}
        status={<Badge tone={client.status === 'active' ? 'success' : 'neutral'} dot>{humanize(client.status)} client</Badge>}
        subtitle={`Client since ${clock.date(client.createdAt)}`}
        facts={[
          ...(client.billingEmail ? [{ label: 'Billing email', value: client.billingEmail, icon: <IconInbox size={14} /> }] : []),
          { label: 'Currency', value: client.currency, icon: <IconInvoices size={14} /> },
          { label: 'Projects', value: `${client.projectsActive} active · ${client.projectsTotal} total`, icon: <IconProjects size={14} /> },
        ]}
        actions={
          <>
            <Link href="/clients" className={buttonClass('secondary', 'sm')}>
              All clients
            </Link>
            {canWriteNotes ? (
              <Link href={`${base}?tab=notes#notes`} className={buttonClass('secondary', 'sm')}>
                <IconPlus size={14} />
                Add note
              </Link>
            ) : null}
            {can(context.role, 'project.write') ? (
              <ClientCreateButtons
                leadId={opportunities.open?.leadId ?? leads[0]?.id ?? null}
                opportunityId={opportunities.open?.id ?? null}
                invoiceHref={invoiceTarget ? `/projects/${invoiceTarget}#billing` : `${base}?tab=invoices`}
              />
            ) : null}
          </>
        }
      />

      <StatGrid>
        <Stat
          label="Next follow-up"
          value={nextFollowUp ? clock.date(nextFollowUp.at) : '—'}
          caption={
            nextFollowUp
              ? `${nextFollowUp.source === 'sequence' ? 'Automated sequence' : 'Set on the lead'} · ${nextFollowUp.leadTitle}`
              : leads.length === 0
                ? 'No lead to follow up'
                : 'Nothing scheduled'
          }
          tone={followUpOverdue ? 'danger' : nextFollowUp ? 'info' : 'neutral'}
          icon={<IconClock size={16} />}
          href={nextFollowUp ? `/leads/${nextFollowUp.leadId}` : undefined}
        />
        <Stat
          label="Unread client replies"
          value={String(unread.total)}
          caption={unread.total > 0 ? `${unread.threads.length} thread${unread.threads.length === 1 ? '' : 's'} waiting` : 'Every message answered'}
          tone={unread.total > 0 ? 'warning' : 'success'}
          icon={<IconMessage size={16} />}
          href={tabHref('communication')}
        />
        <Stat
          label="Next to invoice"
          value={String(eligible.filter((e) => e.eligible).length)}
          caption={eligible.length > 0 ? 'Milestones clear to bill' : 'No unpaid milestone ahead'}
          tone={eligible.some((e) => e.eligible) ? 'brand' : 'neutral'}
          icon={<IconInvoices size={16} />}
          href={tabHref('invoices')}
        />
        <Stat
          label="Meeting notes"
          value={String(meetingNotes.length)}
          caption={`${client.meetings.length} meeting${client.meetings.length === 1 ? '' : 's'} on this client's deals`}
          tone="accent"
          icon={<IconCalendar size={16} />}
          href={tabHref('notes')}
        />
      </StatGrid>

      <div role="tablist" aria-label="Client sections" className="rounded-xl border border-line bg-surface shadow-xs">
        <ul className="scrollbar-none flex overflow-x-auto px-2">
          {TABS.map((t) => (
            <li key={t} className="shrink-0">
              <Link
                href={tabHref(t)}
                role="tab"
                aria-selected={t === tab}
                className={cx(
                  'relative flex h-11 items-center gap-2 px-3.5 text-[13px] font-medium transition-colors',
                  t === tab ? 'text-brand' : 'text-muted hover:text-foreground',
                )}
              >
                {humanize(t)}
                {t === 'communication' && unread.total > 0 ? <Badge tone="warning">{unread.total}</Badge> : null}
                {t === tab ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {tab === 'projects' ? (
        <Card>
          <CardHeader title="Client projects" description={`${client.projectsActive} active of ${client.projectsTotal}.`} actions={<ViewAll href="/projects" />} />
          {client.projects.length > 0 ? (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={client.projects} columns={projectColumns} getKey={(p) => p.id} href={(p) => `/projects/${p.id}`} />
            </div>
          ) : (
            <EmptyState icon={<IconProjects size={20} />} title="No projects yet" description="Winning a deal on one of this client's leads creates one." />
          )}
        </Card>
      ) : null}

      {tab === 'quotations' ? (
        <Card>
          <CardHeader title="Quotations" description="Every quotation raised on this client's deals, newest first." actions={<ViewAll href="/quotations" />} />
          {client.quotations.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No quotation has been raised on this client's deals.</p>
          ) : (
            <ul className="divide-y divide-line">
              {client.quotations.map((qn) => (
                <li key={qn.id}>
                  <Link href={qn.leadId ? `/leads/${qn.leadId}#quotations` : '/quotations'} className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">
                        {qn.title} <span className="font-mono text-[11px] text-muted">v{qn.version}</span>
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {qn.dealName} · {clock.date(qn.createdAt)}
                        {qn.validUntil ? ` · valid until ${clock.date(qn.validUntil)}` : ''}
                      </span>
                    </span>
                    <span className="tabular shrink-0 font-medium">{money(qn.totalMinor, qn.currency)}</span>
                    <StatusBadge status={qn.status} dot={false} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === 'invoices' ? (
        <>
          <Card>
            <CardHeader
              title="Next milestone to invoice"
              description="Per project: the first priced milestone not yet paid for, with everything before it paid — the same rule the project page applies."
            />
            {eligible.length > 0 ? (
              <ul className="divide-y divide-line">
                {eligible.map((e) => {
                  const project = client.projects.find((p) => p.id === e.projectId);
                  return (
                    <li key={e.milestoneId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">{e.name}</span>
                        <span className="block text-[13px] text-muted">
                          {project?.name ?? 'Project'} · {humanize(e.status)}
                          {e.paymentPercent !== null ? <> · {e.paymentPercent}%</> : null} · {money(e.amountMinor, e.currency)}
                        </span>
                        {e.reason ? <span className="block text-xs text-muted">{e.reason}</span> : null}
                      </span>
                      {e.eligible && mayInvoice ? (
                        <GenerateClientInvoiceButton milestoneId={e.milestoneId} projectId={e.projectId} label="Generate invoice" />
                      ) : e.eligible ? (
                        <span className="text-xs text-muted">No permission to raise invoices.</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing to bill next — every priced milestone is paid, or no project has a payment plan yet.</p>
            )}
          </Card>
          {canSeeMoney ? (
            <Card>
              <CardHeader title="Invoices" description={`${money(client.outstandingMinor, client.currency)} outstanding.`} actions={<ViewAll href="/invoices" />} />
              {client.invoices.length > 0 ? (
                <div className="px-4 pb-4 sm:px-5">
                  <DataTable dense rows={client.invoices} columns={invoiceColumns} getKey={(i) => i.id} href={(i) => `/invoices/${i.id}`} />
                </div>
              ) : (
                <EmptyState icon={<IconInvoices size={20} />} title="No invoices yet" />
              )}
            </Card>
          ) : (
            <Callout tone="info">Invoice amounts are visible to roles with the invoice.read permission.</Callout>
          )}
        </>
      ) : null}

      {tab === 'communication' ? (
        <>
          <Card>
            <CardHeader title="Unread client replies" description="Inbound messages after the last outbound one on each thread — replies nobody has answered." />
            {unread.threads.length > 0 ? (
              <ul className="divide-y divide-line">
                {unread.threads.map((t) => (
                  <li key={t.conversationId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">{t.title ?? humanize(t.kind)}</span>
                      <span className="block truncate text-[13px] text-muted">{clock.dateTime(t.latestAt)} · {t.latestBody ?? '(media message)'}</span>
                    </span>
                    <Badge tone="warning">{t.unread} unread</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Every client message has been answered.</p>
            )}
          </Card>
          <Callout tone="info">
            Sending a message from here is not built: outbound WhatsApp goes through each thread's own conversation view, where the 24-hour window and template rules are enforced.
          </Callout>
        </>
      ) : null}

      {tab === 'notes' ? (
        <>
          <Card>
            <CardHeader title="Meeting notes and decisions" description="Typed notes and summaries recorded against meetings on this client's leads, newest first." />
            {meetingNotes.length > 0 ? (
              <ul className="divide-y divide-line">
                {meetingNotes.map((n) => {
                  const lead = leads.find((l) => l.id === n.leadId);
                  return (
                    <li key={n.id} className="flex flex-col gap-1 px-4 py-3 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={n.kind === 'summary' ? 'brand' : 'neutral'}>{n.kind}</Badge>
                        <Badge tone={n.visibility === 'client_visible' ? 'info' : 'neutral'}>{humanize(n.visibility)}</Badge>
                        <span className="text-xs text-muted">
                          {n.meetingAt ? `Meeting ${clock.dateTime(n.meetingAt)}` : 'Meeting undated'}
                          {n.meetingMode ? ` · ${humanize(n.meetingMode)}` : ''} · {humanize(n.meetingStatus)}
                          {n.meetingOutcome ? ` · ${humanize(n.meetingOutcome)}` : ''}
                        </span>
                      </div>
                      {n.body ? <p className="whitespace-pre-wrap text-[13px] text-foreground">{n.body}</p> : <p className="text-[13px] text-muted">Stored as a reference{n.artifactRef ? ` (${n.artifactRef})` : ''}, no text.</p>}
                      <span className="text-xs text-muted">
                        Recorded {clock.dateTime(n.uploadedAt)}
                        {lead ? (
                          <>
                            {' · '}
                            <Link href={`/meetings/${n.meetingId}`} className="underline-offset-2 hover:underline">meeting</Link>
                            {' · '}
                            <Link href={`/leads/${lead.id}`} className="underline-offset-2 hover:underline">{lead.title}</Link>
                          </>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState icon={<IconMessage size={20} />} title="No meeting notes" description="Notes and summaries added to a meeting on one of this client's leads appear here." />
            )}
          </Card>
          <Callout tone="info">
            Attaching a meeting summary to project memory is not offered here: <code>ai.memory_records</code> is written only by the sales handoff handlers, and there is no person-facing door for it.
          </Callout>
        </>
      ) : null}

      {tab === 'activity' ? (
        <ActivityFeed
          title="Commercial timeline"
          items={commercialFeed}
          emptyTitle="No commercial history yet"
          emptyDescription="An accepted quotation, a payment milestone, an invoice or a payment will appear here as each happens."
        />
      ) : null}

      {tab === 'overview' || tab === 'files' || tab === 'notes' || tab === 'communication' ? (
      <>

      {tab === 'overview' ? (
      <StatGrid cols={6}>
        <Stat label="Total projects" value={String(client.projectsTotal)} caption={`${client.projectsActive} active`} tone="brand" icon={<IconProjects size={16} />} />
        {canSeeMoney ? (
          <>
            <Stat label="Total invoiced" value={money(client.invoicedMinor, client.currency)} caption={`${client.invoices.length} invoice${client.invoices.length === 1 ? '' : 's'}`} tone="info" icon={<IconInvoices size={16} />} />
            <Stat label="Total paid" value={money(client.paidMinor, client.currency)} caption={collection === null ? 'Nothing invoiced' : `${collection}% collected`} tone="success" icon={<IconCheck size={16} />} />
            <Stat label="Outstanding" value={money(client.outstandingMinor, client.currency)} caption={pending > 0 ? `${pending} pending` : 'Nothing pending'} tone={client.outstandingMinor > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} />
          </>
        ) : null}
        <Stat label="Client since" value={clock.date(client.createdAt)} caption={monthsSince === 0 ? 'This month' : `${monthsSince} month${monthsSince === 1 ? '' : 's'}`} tone="accent" icon={<IconCalendar size={16} />} />
        <Stat label="Client health" value={healthy ? 'Good' : 'Attention'} caption={overdue > 0 ? `${overdue} overdue invoice${overdue === 1 ? '' : 's'}` : client.status !== 'active' ? humanize(client.status) : 'No overdue invoices'} tone={healthy ? 'success' : 'danger'} icon={healthy ? <IconCheck size={16} /> : <IconAlert size={16} />} />
      </StatGrid>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(19rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {tab === 'overview' ? (
          <>
          <Card>
            <CardHeader title="Client projects" actions={<ViewAll href="/projects" />} />
            {client.projects.length > 0 ? (
              <div className="px-4 pb-4 sm:px-5">
                <DataTable dense rows={client.projects} columns={projectColumns} getKey={(p) => p.id} href={(p) => `/projects/${p.id}`} />
              </div>
            ) : (
              <EmptyState icon={<IconProjects size={20} />} title="No projects yet" />
            )}
          </Card>

          {client.commercials.length > 0 ? (
            <Card>
              <CardHeader title="Commercials" description="What each project was sold for, where its payment plan stands, and its upkeep." />
              <ul className="divide-y divide-line">
                {client.commercials.map((c) => (
                  <li key={c.projectId} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/projects/${c.projectId}`} className="text-[13px] font-semibold hover:underline">{c.projectName}</Link>
                      <StatusBadge status={c.status} />
                      {c.paidChangeRequests > 0 ? <Badge tone="info">{c.paidChangeRequests} paid change{c.paidChangeRequests === 1 ? '' : 's'}</Badge> : null}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
                      <div>
                        <dt className="text-xs text-muted">Accepted quote</dt>
                        <dd className="tabular font-medium">{c.acceptedQuoteMinor !== null ? money(c.acceptedQuoteMinor, c.currency) : <span className="text-muted">none cited</span>}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Milestones</dt>
                        <dd className="font-medium">{c.milestonesTotal === 0 ? <span className="text-muted">no plan</span> : `${c.milestonesMet}/${c.milestonesTotal} met`}</dd>
                        {c.nextMilestone ? <dd className="text-xs text-muted">next: {c.nextMilestone.name}{c.nextMilestone.dueOn ? ` · ${clock.date(c.nextMilestone.dueOn)}` : ''}</dd> : null}
                      </div>
                      {canSeeMoney ? (
                        <div>
                          <dt className="text-xs text-muted">Invoiced / paid</dt>
                          <dd className="tabular font-medium">{money(c.paidMinor, c.currency)} <span className="text-muted">of {money(c.invoicedMinor, c.currency)}</span></dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-xs text-muted">Maintenance</dt>
                        <dd className="font-medium">
                          {c.maintenance ? (
                            <>
                              {c.maintenance.name} <Badge tone={c.maintenance.accepted ? 'success' : 'warning'}>{c.maintenance.accepted ? 'accepted' : 'not accepted'}</Badge>
                              <span className="block text-xs text-muted">{humanize(c.maintenance.billingModel)}{c.maintenance.endsOn ? ` · until ${clock.date(c.maintenance.endsOn)}` : ''}</span>
                            </>
                          ) : (
                            <span className="text-muted">no plan</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                    {c.milestonesTotal > 0 ? <ProgressBar value={(c.milestonesMet / c.milestonesTotal) * 100} label={`${c.projectName} milestones met`} /> : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {canSeeMoney ? (
            <Card>
              <CardHeader title="Recent invoices" actions={<ViewAll href="/invoices" />} />
              {client.invoices.length > 0 ? (
                <div className="px-4 pb-4 sm:px-5">
                  <DataTable dense rows={client.invoices.slice(0, 8)} columns={invoiceColumns} getKey={(i) => i.id} href={(i) => `/invoices/${i.id}`} />
                </div>
              ) : (
                <EmptyState icon={<IconInvoices size={20} />} title="No invoices yet" />
              )}
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Recent quotations" actions={<ViewAll href="/quotations" />} />
              {client.quotations.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No quotation has been raised on this client's deals.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {client.quotations.slice(0, 6).map((qn) => (
                    <li key={qn.id}>
                      <Link href={qn.leadId ? `/leads/${qn.leadId}#quotations` : '/quotations'} className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">
                            {qn.title} <span className="font-mono text-[11px] text-muted">v{qn.version}</span>
                          </span>
                          <span className="block truncate text-xs text-muted">{qn.dealName} · {clock.date(qn.createdAt)}</span>
                        </span>
                        <span className="tabular shrink-0 font-medium">{money(qn.totalMinor, qn.currency)}</span>
                        <StatusBadge status={qn.status} dot={false} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <CardHeader title="Meetings" actions={<ViewAll href="/meetings" />} />
              {client.meetings.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No meeting has been requested or booked on this client's deals.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {client.meetings.slice(0, 6).map((m) => (
                    <li key={m.id}>
                      <Link href={`/meetings/${m.id}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info"><IconCalendar size={14} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">{m.purpose ?? humanize(m.mode ?? 'meeting')}</span>
                          <span className="block truncate text-xs text-muted">{m.startAt ? `${clock.dateTime(m.startAt)}${m.timezone ? ` · ${m.timezone}` : ''}` : 'No time agreed'}</span>
                        </span>
                        <StatusBadge status={m.status} dot={false} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          </>
          ) : null}

          {tab === 'overview' || tab === 'notes' || tab === 'files' ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card id="notes">
              <CardHeader title="Notes" description="Internal only — never shown to the client." />
              {canWriteNotes ? (
                <div className="px-4 pb-3 sm:px-5">
                  <AddClientNoteForm clientAccountId={client.id} />
                </div>
              ) : null}
              {client.notes.length > 0 ? (
                <ul className="divide-y divide-line">
                  {client.notes.slice(0, 6).map((n) => (
                    <li key={n.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                      <Avatar name={n.createdByEmail ?? 'Unknown'} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[13px] font-medium text-foreground">{n.createdByEmail?.split('@')[0] ?? 'Unknown'}</span>
                          <span className="shrink-0 text-[11px] text-faint">{clock.dateTime(n.createdAt)}</span>
                        </span>
                        <span className="block whitespace-pre-wrap text-[13px] text-muted">{n.body}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No notes yet" description="Internal notes about this client will appear here." />
              )}
            </Card>

            <Card>
              <CardHeader title="Client files" description="Rolled up from every project this client has." />
              {client.files.length > 0 ? (
                <ul className="divide-y divide-line">
                  {client.files.slice(0, 6).map((f) => (
                    <li key={f.id}>
                      <a href={f.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover sm:px-5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                          <IconFile size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-foreground">{f.title}</span>
                          <span className="block truncate text-xs text-muted">
                            {f.projectName} · {humanize(f.category)}
                          </span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={<IconFile size={20} />} title="No files yet" description="Files linked on any of this client's projects appear here." />
              )}
            </Card>
          </div>
          ) : null}

          {tab === 'overview' || tab === 'communication' ? (
          <Card>
            <CardHeader title="Communication" description="Each project's own WhatsApp group, most recent messages first." />
            {client.communication.length > 0 ? (
              <ul className="flex flex-col gap-4 px-4 py-3 sm:px-5">
                {client.communication.map((thread) => (
                  <li key={thread.conversationId} className="flex flex-col gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {thread.title ?? thread.projectName}
                      <span className="ml-2 text-xs font-normal text-muted">{thread.projectName}</span>
                    </p>
                    {thread.messages.length === 0 ? (
                      <p className="text-[13px] text-muted">No messages yet.</p>
                    ) : (
                      <ul className="flex flex-col gap-1.5 border-l-2 border-line pl-3">
                        {thread.messages.map((m) => (
                          <li key={m.id} className="text-[13px]">
                            <span className="font-medium text-foreground">{m.direction === 'inbound' ? 'Client' : humanize(m.authorType)}</span>{' '}
                            <span className="text-xs text-muted">{clock.dateTime(m.occurredAt)}</span>
                            <p className="text-muted">{m.body ?? '(no text — media message)'}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<IconInbox size={20} />} title="No project group linked yet" description="A project's WhatsApp group, once linked, shows its messages here." />
            )}
          </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <DetailPanel
            title="Client details"
            rows={[
              { label: 'Company name', value: client.name },
              { label: 'Billing email', value: client.billingEmail ?? 'Not set' },
              { label: 'Currency', value: client.currency },
              { label: 'Status', value: <Badge tone={client.status === 'active' ? 'success' : 'neutral'}>{humanize(client.status)}</Badge> },
              { label: 'Client since', value: clock.date(client.createdAt) },
              { label: 'Projects', value: `${client.projectsActive} active of ${client.projectsTotal}` },
              ...(canSeeMoney ? [{ label: 'Collection', value: collection === null ? 'Nothing invoiced' : `${collection}% of ${money(client.invoicedMinor, client.currency)}` }] : []),
            ]}
          />

          <Card>
            <CardHeader title={`Contacts (${client.contacts.length})`} />
            {client.contacts.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">
                <IconUser size={14} className="mr-1 inline align-[-2px]" />
                {client.billingEmail ? `Billing: ${client.billingEmail}` : 'No contact on file.'}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {client.contacts.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                    <Avatar name={c.fullName} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">{c.fullName}</span>
                      <span className="block truncate text-xs text-muted">{[c.jobTitle, c.email, c.phone].filter(Boolean).join(' · ') || 'No details'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <ActivityFeed title="Client timeline" items={timeline} emptyTitle="Nothing recorded yet" compact viewAllHref={tabHref('activity')} />
          {commercialFeed.length > 0 && tab === 'overview' ? (
            <ActivityFeed title="Commercials" items={commercialFeed.slice(0, 6)} viewAllHref={tabHref('activity')} compact />
          ) : null}
        </div>
      </div>
      </>
      ) : null}
    </div>
  );
}
