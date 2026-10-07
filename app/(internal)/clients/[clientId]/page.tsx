import { ContractsTable } from '../../contracts/contracts-list';
import { listContracts } from '@/modules/sales/contract-service';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock, getAgencyTimeZone, type AgencyClock } from '@/lib/admin/agency-clock';
import { listClientChangeRequests } from '@/lib/admin/client-change-requests';
import { readClientIdentity } from '@/lib/admin/client-edit';
import { listClientProjectStatusCounts } from '@/lib/admin/client-projects';
import { readClientTeam } from '@/lib/admin/client-team';
import { listClientUploads } from '@/lib/admin/client-uploads';
import { readClientCommercialTimeline, type CommercialEvent } from '@/lib/admin/client-commercials';
import { listClientMeetingNotes, readClientUnreadReplies } from '@/lib/admin/client-communication';
import { listClientLeadThreads } from '@/lib/admin/client-threads';
import { collaborationFeed, lastAnnouncement, meetingSignals } from '@/modules/crm/client-collaboration';
import { maintenanceSentence, summariseCommercials } from '@/modules/sales/client-commercial-summary';
import { readClientNextFollowUp } from '@/lib/admin/client-followups';
import { listClientLeads, listClientOpportunities } from '@/lib/admin/client-leads';
import { getClient } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listAnnouncements } from '@/modules/crm/announcements-queries';
import { listEligibleMilestones } from '@/modules/finance/eligible-milestones-queries';
import { readStorageStatus } from '@/modules/projects/files-storage-queries';
import { listInternalRoster } from '@/modules/projects/queries';
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
  IconActivity,
  IconClock,
  IconEdit,
  IconFile,
  IconInbox,
  IconInvoices,
  IconLeads,
  IconMessage,
  IconPlus,
  IconProjects,
  IconRefresh,
  IconSettings,
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
  RowActionsMenu,
} from '@/ui';

import { TrailLabel } from '../../trail-label';
import { GenerateClientInvoiceButton } from './client-forms';
import { ClientEditForm } from '../client-edit-form';
import { ClientMeetingForm, ClientUploadForm, RenewalForm } from './client-360-forms';
import { ClientCreateButtons } from './create-buttons';
import { ClientTeamForm } from './settings-forms';
import { AddClientNoteForm } from './note-form';
import { ClientOwnerForm, ClientTagsForm } from './ownership-forms';
import { ClientSendForm } from './send-form';
import { AttachMeetingSummaryForm } from '../../meetings/[meetingId]/attach-memory-form';

const TABS = ['overview', 'projects', 'quotations', 'invoices', 'communication', 'files', 'notes', 'activity', 'settings'] as const;
type Tab = (typeof TABS)[number];

function tabOf(value: string | undefined): Tab {
  return (TABS as readonly string[]).includes(value ?? '') ? (value as Tab) : 'overview';
}

const TAB_ICON: Record<Tab, React.ReactNode> = {
  overview: <IconClock size={14} />,
  projects: <IconProjects size={14} />,
  quotations: <IconLeads size={14} />,
  invoices: <IconInvoices size={14} />,
  communication: <IconMessage size={14} />,
  files: <IconFile size={14} />,
  notes: <IconEdit size={14} />,
  activity: <IconActivity size={14} />,
  settings: <IconSettings size={14} />,
};

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
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const client = await getClient(clientId);
  if (!client) notFound();

  // SCR-015/016/017's additions, each from its own reader: the client's
  // leads (for the follow-up and meeting notes), the next follow-up, unread
  // replies, meeting notes, the commercial timeline and the milestone each
  // project could be invoiced for next.
  const leads = await listClientLeads(clientId);
  const leadIds = leads.map((l) => l.id);
  const projectIds = client.projects.map((p) => p.id);
  // SCR-017 — the lead threads a message can be sent on from here, and who
  // may: the same `lead.write` the lead composer and the memory door gate on.
  const mayMessage = can(context, 'lead.write');
  const leadThreads = mayMessage ? await listClientLeadThreads(leadIds) : [];
  const threadOptions = leadThreads.map((t) => {
    const lead = leads.find((l) => l.id === t.leadId);
    return { conversationId: t.conversationId, leadId: t.leadId, label: `${lead?.title ?? t.leadId.slice(0, 8)} · ${t.title ?? humanize(t.kind)} (${t.channel})` };
  });
  const memoryProjects = client.projects.map((p) => ({ id: p.id, name: p.name }));
  const [nextFollowUp, unread, meetingNotes, commercialEvents, eligible, opportunities] = await Promise.all([
    readClientNextFollowUp(clientId, leads),
    readClientUnreadReplies({ projectIds, leadIds }),
    listClientMeetingNotes(leadIds),
    readClientCommercialTimeline({ clientAccountId: clientId, projects: client.projects }),
    listEligibleMilestones(projectIds),
    listClientOpportunities(clientId),
  ]);
  // Decision 10: the contracts on this client's won deals, shown beside its quotations.
  const clientContracts = tab === 'quotations' ? await listContracts({ clientAccountId: clientId }) : [];
  const mayInvoice = can(context, 'invoice.create');
  const mayEditClient = can(context, 'project.write');
  // SCR-014 (owner select) and SCR-017 (announcements addressed to clients).
  const [roster, clientAnnouncements] = await Promise.all([
    mayEditClient ? listInternalRoster() : Promise.resolve([]),
    // SCR-059: what is recorded against THIS client (or a project of theirs), plus the agency-wide ones — never another client's.
    listAnnouncements({ audience: 'clients', status: 'published', limit: 10, clientAccountId: clientId }),
  ]);
  const rosterOptions = roster.map((m) => ({ userId: m.userId, fullName: m.fullName || m.email }));
  // SCR-015/016/017 (bucket F-B): the identity the edit door writes, the
  // assigned team, per-status project counts, change-request charges,
  // recent uploads, storage reachability for the upload door, and the
  // agency zone for the meeting form.
  const [identity, team, statusCounts, changeRequests, uploads, storage, agencyZone] = await Promise.all([
    readClientIdentity(clientId),
    readClientTeam(clientId),
    listClientProjectStatusCounts([clientId]),
    listClientChangeRequests(client.projects.map((p) => ({ id: p.id, name: p.name, currency: p.currency }))),
    listClientUploads(client.projects.map((p) => ({ id: p.id, name: p.name }))),
    context.organizationId ? readStorageStatus(context.organizationId) : Promise.resolve({ reachable: false as const, bucket: '', reason: 'No organization on this session.' }),
    getAgencyTimeZone(),
  ]);
  const byStatus = statusCounts.get(clientId)?.byStatus ?? {};
  const completedProjects = client.projects.filter((p) => p.status === 'completed').map((p) => ({ id: p.id, name: p.name }));
  const milestoneSchedule = commercialEvents.filter((e) => e.kind === 'milestone');
  const leadOptions = leads.map((l) => ({ id: l.id, title: l.title, conversationId: leadThreads.find((t) => t.leadId === l.id)?.conversationId ?? null }));
  const chargedTotal = changeRequests.filter((cr) => cr.amountMinor !== null && cr.currency === client.currency && cr.status !== 'rejected').reduce((n, cr) => n + (cr.amountMinor ?? 0), 0);
  const base = `/clients/${clientId}`;
  const tabHref = (t: Tab) => (t === 'overview' ? base : `${base}?tab=${t}`);
  const invoiceTarget = eligible.find((e) => e.eligible)?.projectId ?? null;
  const commercialFeed = commercialItems(commercialEvents, clock);
  const newestAnnouncement = lastAnnouncement(clientAnnouncements);
  const commercialSummary = summariseCommercials(client.commercials, client.currency, new Date().toISOString().slice(0, 10));
  const maintenanceLine = maintenanceSentence(commercialSummary.maintenance);
  const signals = meetingSignals(meetingNotes);
  const collaboration = collaborationFeed({
    clientName: client.name,
    announcements: clientAnnouncements,
    uploads,
    meetingNotes,
    internalNotes: client.notes,
    unread: unread.threads,
  });
  const followUpOverdue = nextFollowUp !== null && nextFollowUp.at < new Date().toISOString();

  const canWriteNotes = can(context, 'project.write');
  const canSeeMoney = can(context, 'invoice.read');
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
          <Avatar name={p.name} size="sm" square tone="sidebar" />
          <span className="min-w-0">
            <span className="block truncate">{p.name}</span>
            <span className="block truncate font-mono text-[11px] font-normal text-muted">{p.projectCode}</span>
          </span>
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
    // SCR-016 "Open project finance" — the project's own finance view.
    ...(canSeeMoney
      ? ([{ key: 'finance', header: 'Finance', align: 'right', desktopOnly: true, cell: (p: ProjectRow) => <Link href={`/projects/${p.id}/finance`} className="text-xs font-medium text-brand hover:underline">Open finance</Link> }] as Column<ProjectRow>[])
      : []),
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

  // Deal Timeline: the milestones of the relationship that are on record, oldest first, with the
  // next follow-up (if any) as the open step at the end. Every entry is a stored row's date.
  const dealTimeline: { key: string; at: string; title: string; done: boolean }[] = [
    ...leads.map((l) => ({ key: `lead-${l.id}`, at: l.createdAt, title: 'Lead created', done: true })),
    ...client.meetings.filter((m) => m.startAt).map((m) => ({ key: `meeting-${m.id}`, at: m.startAt as string, title: m.status === 'completed' || m.status === 'held' ? 'Meeting held' : `Meeting ${humanize(m.status).toLowerCase()}`, done: m.status === 'completed' || m.status === 'held' })),
    ...client.quotations.map((qn) => ({ key: `q-${qn.id}`, at: qn.createdAt, title: `Quotation v${qn.version} ${humanize(qn.status).toLowerCase()}`, done: true })),
    { key: 'client', at: client.createdAt, title: 'Client account created', done: true },
    ...(nextFollowUp ? [{ key: 'next', at: nextFollowUp.at, title: 'Next follow-up', done: false }] : []),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const workTiles = (
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
  );

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name={client.name} />
      <EntityHeader
        name={client.name}
        tile={<Avatar name={client.name} size="xl" />}
        status={<Badge tone={client.status === 'active' ? 'success' : 'neutral'} dot>{humanize(client.status)} client</Badge>}
        subtitle={`Client since ${clock.date(client.createdAt)}`}
        facts={[
          { label: 'Client ID', value: <span className="font-mono">{client.clientCode}</span>, icon: <IconUser size={14} /> },
          ...(client.billingEmail ? [{ label: 'Billing email', value: client.billingEmail, icon: <IconInbox size={14} /> }] : []),
          { label: 'Currency', value: client.currency, icon: <IconInvoices size={14} /> },
          { label: 'Projects', value: `${client.projectsActive} active · ${client.projectsTotal} total`, icon: <IconProjects size={14} /> },
        ]}
        actions={
          <>
            <Link href="/clients" className={buttonClass('secondary', 'sm')}>
              All clients
            </Link>
            <Link href={`/clients/${client.id}/customer-360`} className={buttonClass('secondary', 'sm')}>
              Customer 360
            </Link>
            {canWriteNotes ? (
              <Link href={`${base}?tab=notes#notes`} className={buttonClass('secondary', 'sm')}>
                <IconPlus size={14} />
                Add note
              </Link>
            ) : null}
            {can(context, 'project.write') ? (
              <ClientCreateButtons
                clientAccountId={client.id}
                opportunityId={opportunities.open?.id ?? null}
                invoiceHref={invoiceTarget ? `/projects/${invoiceTarget}#billing` : `${base}?tab=invoices`}
              />
            ) : null}
            {mayMessage ? <ClientMeetingForm leads={leadOptions} agencyZone={agencyZone} /> : null}
            {/* The context header's overflow: the rest of this client's record. */}
            <RowActionsMenu
              label="More actions for this client"
              actions={[
                { key: 'communication', label: 'Communication', href: tabHref('communication') },
                { key: 'files', label: 'Files', href: tabHref('files') },
                { key: 'activity', label: 'Activity', href: tabHref('activity') },
                { key: 'settings', label: 'Settings and billing details', href: tabHref('settings') },
                { key: 'search', label: 'Find related records', href: `/search?q=${encodeURIComponent(client.name)}` },
              ]}
            />
          </>
        }
      />


      <nav aria-label="Client sections" className="rounded-xl border border-line bg-surface shadow-xs">
        <ul className="scrollbar-none flex overflow-x-auto px-2">
          {TABS.map((t) => (
            <li key={t} className="shrink-0">
              <Link
                href={tabHref(t)}
                aria-current={t === tab ? 'page' : undefined}
                className={cx(
                  'relative flex h-11 items-center gap-2 px-3.5 text-[13px] font-medium transition-colors',
                  t === tab ? 'text-brand' : 'text-muted hover:text-foreground',
                )}
              >
                <span className="shrink-0">{TAB_ICON[t]}</span>
                {humanize(t)}
                {t === 'communication' && unread.total > 0 ? <Badge tone="warning">{unread.total}</Badge> : null}
                {t === tab ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab !== 'overview' && tab !== 'communication' ? workTiles : null}

      {tab === 'settings' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {/* SCR-015 — the Settings tab: owner, tags, billing identity, assigned team. */}
          <Card>
            <CardHeader title="Billing details" description="Name, legal name, GSTIN, PAN and billing address — the account's identity on every document. The GSTIN's checksum is verified; a pass is not a registration. Audited." />
            <div className="px-4 pb-4 sm:px-5">
              {mayEditClient && canSeeMoney && identity ? <ClientEditForm client={identity} /> : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                  <dt className="text-muted">Legal name</dt><dd>{client.legalName ?? '—'}</dd>
                  {/* SCR-015: GST/PAN and billing data need the finance capability, not just the right to see the client. */}
                  <dt className="text-muted">GSTIN</dt><dd className="font-mono">{canSeeMoney ? (client.gstin ?? '—') : 'Restricted'}</dd>
                  <dt className="text-muted">PAN</dt><dd className="font-mono">{canSeeMoney ? (client.pan ?? '—') : 'Restricted'}</dd>
                  <dt className="text-muted">Billing address</dt><dd className="whitespace-pre-wrap">{canSeeMoney ? (client.billingAddress ?? '—') : 'Restricted'}</dd>
                </dl>
              )}
            </div>
          </Card>
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader title="Relationship" description="Who answers for this client, and how it is tagged." />
              <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                {mayEditClient ? (
                  <>
                    <ClientOwnerForm clientAccountId={client.id} ownerId={client.ownerId} roster={rosterOptions} />
                    <ClientTagsForm clientAccountId={client.id} tags={client.tags} />
                  </>
                ) : (
                  <p className="text-[13px] text-muted">Owner: {client.ownerName ?? 'nobody'} · Tags: {client.tags.join(', ') || 'none'}</p>
                )}
              </div>
            </Card>
            <Card>
              <CardHeader title="Assigned team" description={`${team.length} assigned. Every name must hold an active membership; the set is replaced whole and audited.`} />
              <div className="px-4 pb-4 sm:px-5">
                {mayEditClient ? (
                  <ClientTeamForm clientAccountId={client.id} members={roster.map((m) => ({ userId: m.userId, fullName: m.fullName || m.email, role: m.role }))} assigned={team} />
                ) : team.length === 0 ? (
                  <p className="text-[13px] text-muted">Nobody assigned yet.</p>
                ) : (
                  <ul className="flex flex-wrap gap-1">{team.map((id) => <Badge key={id} tone="neutral">{roster.find((m) => m.userId === id)?.fullName ?? id.slice(0, 8)}</Badge>)}</ul>
                )}
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === 'projects' ? (
        <>
        {/* SCR-016 — projects by status: a count per status word, each a link to the list filtered to it. */}
        <StatGrid cols={5}>
          {(['planning', 'active', 'on_hold', 'completed', 'cancelled'] as const).map((st) => (
            <Stat key={st} label={humanize(st)} value={String(byStatus[st] ?? 0)} tone={st === 'completed' ? 'success' : st === 'active' ? 'brand' : st === 'on_hold' ? 'warning' : 'neutral'} icon={<IconProjects size={16} />} href={`/projects?status=${st}&client=${client.id}`} />
          ))}
        </StatGrid>
        {/* SCR-016's other header figures: accepted quote value, paid against outstanding, maintenance and renewal. */}
        <StatGrid>
          <Stat
            label="Accepted quote value"
            value={money(commercialSummary.acceptedQuoteMinor, client.currency)}
            caption={
              commercialSummary.cited === 0
                ? 'No project cites an accepted quotation'
                : `${commercialSummary.cited} of ${commercialSummary.projects} project${commercialSummary.projects === 1 ? '' : 's'} cite one${commercialSummary.otherCurrency > 0 ? ` · ${commercialSummary.otherCurrency} in another currency, not added` : ''}`
            }
            tone="brand"
            icon={<IconInvoices size={16} />}
          />
          {canSeeMoney ? (
            <Stat
              label="Paid vs outstanding"
              value={<span className="text-lg">{money(client.paidMinor, client.currency)} <span className="text-muted">/ {money(client.outstandingMinor, client.currency)}</span></span>}
              caption={`Verified payments against ${money(client.invoicedMinor, client.currency)} invoiced`}
              tone={client.outstandingMinor > 0 ? 'warning' : 'success'}
              icon={<IconCheck size={16} />}
              href={tabHref('invoices')}
            />
          ) : null}
          <Stat label="Maintenance and renewal" value={maintenanceLine.value} caption={maintenanceLine.caption} tone={commercialSummary.maintenance.lapsed > 0 ? 'warning' : 'neutral'} icon={<IconRefresh size={16} />} />
        </StatGrid>
        <Card>
          <CardHeader title="Client projects" description={`${client.projectsActive} active of ${client.projectsTotal}.`} actions={<ViewAll href="/projects" />} />
          {client.projects.length > 0 ? (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={client.projects} columns={projectColumns} getKey={(p) => p.id} href={(p) => `/projects/${p.id}`} />
            </div>
          ) : (
            <EmptyState icon={<IconProjects size={20} />} title="No projects yet" description="Winning a deal on one of this client's leads creates one, and so does the Create project button above." />
          )}
        </Card>

        {/* SCR-016 — the milestone schedule across the client's projects, dated. */}
        <Card>
          <CardHeader title="Milestone schedule" description="Every payment milestone on this client's projects, in order, with its due date and amount." />
          {milestoneSchedule.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No milestone plan on any project yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {milestoneSchedule.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-[13px] sm:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground">{e.title}</span>
                    <span className="block text-xs text-muted">{e.projectName}{e.detail ? ` · ${e.detail}` : ''}</span>
                  </span>
                  <StatusBadge status={e.status} dot={false} />
                  <span className="tabular text-xs text-muted">{eventWhen(clock, e.at)}</span>
                  {e.amountMinor !== null ? <span className="tabular font-medium">{money(e.amountMinor, e.currency)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* SCR-016 — change-request charges, with the amount each was priced at. */}
        <Card>
          <CardHeader title="Change-request charges" description={`Every change request on this client's projects. Priced changes carry their quotation's total; ${money(chargedTotal, client.currency)} charged in all.`} />
          {changeRequests.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No change request has been raised on this client's projects.</p>
          ) : (
            <ul className="divide-y divide-line">
              {changeRequests.map((cr) => (
                <li key={cr.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-[13px] sm:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{cr.requested}</span>
                    <span className="block text-xs text-muted">
                      <Link href={`/projects/${cr.projectId}`} className="hover:underline">{cr.projectName}</Link> · {clock.date(cr.createdAt)}
                      {cr.classification ? ` · ${humanize(cr.classification)}` : ''}
                    </span>
                  </span>
                  <StatusBadge status={cr.status} dot={false} />
                  {cr.amountMinor !== null ? (
                    <span className="tabular font-medium">{money(cr.amountMinor, cr.currency)}{cr.proposalVersion !== null ? <span className="ml-1 text-xs font-normal text-muted">v{cr.proposalVersion} {cr.proposalStatus ? humanize(cr.proposalStatus) : ''}</span> : null}</span>
                  ) : (
                    <span className="text-xs text-muted">not priced yet</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* SCR-016 — renewal / upsell: a new deal of a stated kind from a completed project. */}
        <Card>
          <CardHeader title="Renewal / upsell" description="Opens a new opportunity in discovery on the original lead, naming the completed project it continues. Audited." />
          <div className="px-4 pb-4 sm:px-5">
            {mayMessage ? <RenewalForm clientAccountId={client.id} completedProjects={completedProjects} /> : <p className="text-[13px] text-muted">Your role can read this but not open deals.</p>}
          </div>
        </Card>
        </>
      ) : null}

      {tab === 'quotations' ? (
        <>
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
        <Card>
          <CardHeader title="Contracts" description="The contract recorded on each of this client's won deals: the file, who signed it and when." actions={<ViewAll href="/contracts" />} />
          {clientContracts.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No contract has been recorded on this client's won deals.</p>
          ) : (
            <ContractsTable rows={clientContracts} clock={clock} mayWrite={false} showClient={false} />
          )}
        </Card>
        </>
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
          {/* SCR-017's header: unread replies, the last announcement, recent uploads, meeting decisions and open questions. */}
          <StatGrid cols={4}>
            <Stat
              label="Unread client replies"
              value={String(unread.total)}
              caption={unread.total > 0 ? `${unread.threads.length} thread${unread.threads.length === 1 ? '' : 's'} waiting` : 'Every message answered'}
              tone={unread.total > 0 ? 'warning' : 'success'}
              icon={<IconMessage size={16} />}
            />
            <Stat
              label="Last announcement"
              value={<span className="text-lg">{newestAnnouncement?.publishedAt ? clock.date(newestAnnouncement.publishedAt) : '—'}</span>}
              caption={newestAnnouncement ? newestAnnouncement.title : 'None published for this client'}
              tone="info"
              icon={<IconInbox size={16} />}
            />
            <Stat
              label="Recent uploads"
              value={String(uploads.length)}
              caption={uploads[0] ? `Newest ${clock.date(uploads[0].uploadedAt)} · ${uploads[0].title}` : 'Nothing uploaded on its projects'}
              tone="accent"
              icon={<IconFile size={16} />}
            />
            <Stat
              label="Meeting decisions / open questions"
              value={`${signals.decisions} / ${signals.openQuestions}`}
              caption={signals.analysed > 0 ? `Proposed by ${signals.analysed} analysed meeting${signals.analysed === 1 ? '' : 's'}; not agreed until a person says so` : `${signals.notes} meeting note${signals.notes === 1 ? '' : 's'}, none analysed yet`}
              tone={signals.openQuestions > 0 ? 'warning' : 'neutral'}
              icon={<IconCalendar size={16} />}
              href={tabHref('notes')}
            />
          </StatGrid>
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
          <Card>
            <CardHeader title="Announcements" description="Published for clients — a record of what was announced, not a send. A governed send to many clients is a campaign under Communication › Campaigns." />
            {clientAnnouncements.length > 0 ? (
              <ul className="divide-y divide-line">
                {clientAnnouncements.map((a) => (
                  <li key={a.id} className="flex flex-col gap-0.5 px-4 py-2.5 text-[13px] sm:px-5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{a.title}</span>
                      {a.projectName ? <Badge tone="brand">Project: {a.projectName}</Badge> : a.clientName ? <Badge tone="neutral">For this client</Badge> : <Badge tone="neutral">Agency-wide</Badge>}
                    </span>
                    <span className="whitespace-pre-wrap text-muted">{a.body}</span>
                    <span className="text-xs text-faint">Published {a.publishedAt ? clock.dateTime(a.publishedAt) : '—'}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No announcement has been published for clients.</p>
            )}
          </Card>
          {/* SCR-017 — recent uploads: the stored files across the client's projects, newest first. */}
          <Card>
            <CardHeader title="Recent uploads" description="Files stored on this client's projects, newest first. A download is a short-lived signed link under your own session." />
            {uploads.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing has been uploaded on this client's projects yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {uploads.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-2 text-[13px] sm:px-5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"><IconFile size={15} /></span>
                    <span className="min-w-0 flex-1">
                      <a href={f.downloadHref} className="block truncate font-medium text-foreground underline-offset-2 hover:underline">{f.title}{f.version > 1 ? ` · v${f.version}` : ''}</a>
                      <span className="block truncate text-xs text-muted">{f.projectName} · {humanize(f.category)} · {clock.dateTime(f.uploadedAt)}{f.uploadedByEmail ? ` · ${f.uploadedByEmail.split('@')[0]}` : ''}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Callout tone="info">
            Outbound WhatsApp goes through each thread's own conversation view (or the composer below on the Communication card), where the 24-hour window and template rules are enforced.
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
                      {/* SCR-017 — attach what this meeting said to a project's memory. */}
                      {mayMessage && n.body ? <AttachMeetingSummaryForm meetingId={n.meetingId} projects={memoryProjects} clientId={clientId} compact /> : null}
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
            “Attach to project memory” files the meeting’s newest summary (or typed notes) as a project-scoped memory with the evidence as its source — explicit when a person typed it, inferred when an analysis produced it. Owner or ops admin; once per project and note.
          </Callout>
        </>
      ) : null}

      {tab === 'activity' ? (
        <>
          <ActivityFeed
            title="Commercial timeline"
            items={commercialFeed}
            emptyTitle="No commercial history yet"
            emptyDescription="An accepted quotation, a payment milestone, an invoice or a payment will appear here as each happens."
          />
          {/* SCR-017 "Activity": every collaboration record with its author, time, source and linkage. */}
          <ActivityFeed
            title="Collaboration activity"
            items={collaboration.map((e) => ({
              id: e.key,
              title: e.title,
              detail: (
                <span className="flex flex-col gap-0.5">
                  {e.detail ? <span>{e.detail}</span> : null}
                  <span className="text-xs text-faint">
                    {e.by ? `By ${e.by} · ` : ''}Filed on {e.linkage}
                    {e.internal ? ' · internal, never sent to the client' : ''}
                  </span>
                </span>
              ),
              when: clock.dateTime(e.at),
              tone: e.kind === 'client_reply' ? ('warning' as const) : e.internal ? ('neutral' as const) : ('info' as const),
              icon: e.kind === 'upload' ? <IconFile size={13} /> : e.kind === 'meeting_note' ? <IconCalendar size={13} /> : e.kind === 'announcement' ? <IconInbox size={13} /> : <IconMessage size={13} />,
            }))}
            emptyTitle="No collaboration yet"
            emptyDescription="A client reply, an announcement, an upload, a meeting note or an internal note appears here with who wrote it and where it is filed."
          />
        </>
      ) : null}

      {tab === 'overview' || tab === 'files' || tab === 'notes' || tab === 'communication' ? (
      <>

      {tab === 'overview' ? (
      <StatGrid cols={6}>
        <Stat label="Total projects" value={String(client.projectsTotal)} caption={Object.entries(byStatus).map(([st, n]) => `${n} ${humanize(st).toLowerCase()}`).join(' · ') || 'none yet'} tone="brand" icon={<IconProjects size={16} />} href={tabHref('projects')} />
        {canSeeMoney ? (
          <>
            <Stat label="Total invoiced" value={money(client.invoicedMinor, client.currency)} caption={`${client.invoices.length} invoice${client.invoices.length === 1 ? '' : 's'}`} tone="info" icon={<IconInvoices size={16} />} />
            <Stat label="Total paid" value={money(client.paidMinor, client.currency)} caption={collection === null ? 'Nothing invoiced' : `${collection}% collected`} tone="success" icon={<IconCheck size={16} />} />
            <Stat label="Outstanding" value={money(client.outstandingMinor, client.currency)} caption={pending > 0 ? `${pending} pending` : 'Nothing pending'} tone={client.outstandingMinor > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} />
          </>
        ) : null}
        <Stat label="Client since" value={<span className="text-lg">{clock.date(client.createdAt)}</span>} caption={monthsSince === 0 ? 'This month' : `${monthsSince} month${monthsSince === 1 ? '' : 's'}`} tone="accent" icon={<IconCalendar size={16} />} />
        <Stat label="Client health" value={healthy ? 'Good' : 'Attention'} caption={overdue > 0 ? `${overdue} overdue invoice${overdue === 1 ? '' : 's'}` : client.status !== 'active' ? humanize(client.status) : 'No overdue invoices'} tone={healthy ? 'success' : 'danger'} icon={healthy ? <IconCheck size={16} /> : <IconAlert size={16} />} />
      </StatGrid>
      ) : null}
      {tab === 'overview' ? workTiles : null}

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
              <CardHeader title="Client files" description="Rolled up from every project this client has: stored uploads first, then linked files." />
              {/* SCR-015/017 — upload through the bucket-E storage door, on a project of this client. */}
              {mayEditClient ? (
                <div className="border-b border-line px-4 py-3 sm:px-5">
                  {!storage.reachable ? <p className="mb-2 text-xs text-warning">Storage is not reachable, so nothing can be uploaded: {storage.reason}</p> : null}
                  <ClientUploadForm clientId={client.id} projects={client.projects.map((p) => ({ id: p.id, name: p.name }))} reachable={storage.reachable} />
                </div>
              ) : null}
              {uploads.length > 0 ? (
                <ul className="divide-y divide-line border-b border-line">
                  {uploads.slice(0, 6).map((f) => (
                    <li key={f.id}>
                      <a href={f.downloadHref} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover sm:px-5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success"><IconFile size={15} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-foreground">{f.title}{f.version > 1 ? ` · v${f.version}` : ''}</span>
                          <span className="block truncate text-xs text-muted">{f.projectName} · {humanize(f.category)} · uploaded {clock.date(f.uploadedAt)}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
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
              ) : uploads.length === 0 ? (
                <EmptyState icon={<IconFile size={20} />} title="No files yet" description="Files uploaded or linked on any of this client's projects appear here." />
              ) : null}
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
            {/* SCR-017 — send a permitted message from here: the lead
                composer's own door, with a thread picker over the client's
                lead conversations. The door decides the window and consent. */}
            {mayMessage ? (
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <p className="mb-2 text-[13px] font-medium text-foreground">Send a message on a lead thread</p>
                <ClientSendForm clientId={clientId} threads={threadOptions} />
              </div>
            ) : null}
          </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <DetailPanel
            title="Client details"
            rows={[
              { label: 'Company name', value: client.name },
              ...(client.legalName ? [{ label: 'Legal name', value: client.legalName }] : []),
              ...(client.gstin && canSeeMoney ? [{ label: 'GSTIN', value: <span className="font-mono">{client.gstin}</span> }] : []),
              ...(client.pan && canSeeMoney ? [{ label: 'PAN', value: <span className="font-mono">{client.pan}</span> }] : []),
              { label: 'Billing email', value: client.billingEmail ?? 'Not set' },
              { label: 'Currency', value: client.currency },
              { label: 'Status', value: <Badge tone={client.status === 'active' ? 'success' : 'neutral'}>{humanize(client.status)}</Badge> },
              { label: 'Client since', value: clock.date(client.createdAt) },
              { label: 'Projects', value: `${client.projectsActive} active of ${client.projectsTotal}` },
              ...(canSeeMoney ? [{ label: 'Collection', value: collection === null ? 'Nothing invoiced' : `${collection}% of ${money(client.invoicedMinor, client.currency)}` }] : []),
              { label: 'Owner', value: client.ownerName ?? <span className="text-muted">Nobody yet</span> },
              {
                label: 'Tags',
                value:
                  client.tags.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {client.tags.map((t) => (
                        <Link key={t} href={`/clients?tag=${encodeURIComponent(t)}`}>
                          <Badge tone="neutral">{t}</Badge>
                        </Link>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted">None</span>
                  ),
              },
            ]}
          >
            {mayEditClient ? (
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <Link href={tabHref('settings')} className="text-xs font-medium text-brand hover:underline">
                  Edit owner, tags, billing details and team →
                </Link>
              </div>
            ) : null}
          </DetailPanel>

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

          <Card>
            <CardHeader title="Assigned Team" actions={mayEditClient ? <Link href={tabHref('settings')} className="text-xs font-medium text-brand hover:underline">Manage</Link> : undefined} />
            {team.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No one is assigned to this client yet.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-3 px-4 pb-4 sm:px-5">
                {team.map((id) => {
                  const m = roster.find((r) => r.userId === id);
                  return (
                    <li key={id} className="flex min-w-0 items-center gap-2">
                      <Avatar name={m?.fullName || m?.email || id} size="md" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-foreground">{m?.fullName || m?.email?.split('@')[0] || id.slice(0, 8)}</span>
                        <span className="block truncate text-xs text-muted">{m ? humanize(m.role) : ''}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Deal Timeline" actions={<ViewAll href={tabHref('activity')} />} />
            {dealTimeline.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing recorded yet.</p>
            ) : (
              <ol className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                {dealTimeline.slice(-6).map((e) => (
                  <li key={e.key} className="flex items-start gap-3">
                    <span className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full', e.done ? 'bg-success text-white' : 'border-2 border-line-strong')}>
                      {e.done ? <IconCheck size={12} /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-foreground">{e.title}</span>
                      <span className="block text-xs text-muted">{clock.dateTime(e.at)}</span>
                    </span>
                  </li>
                ))}
              </ol>
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
