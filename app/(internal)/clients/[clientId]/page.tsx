import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { getClient } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  ActivityFeed,
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
} from '@/ui';

import { TrailLabel } from '../../trail-label';
import { AddClientNoteForm } from './note-form';

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
export default async function ClientDetailPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;

  const context = await requireInternal(`/clients/${clientId}`);
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const client = await getClient(clientId);
  if (!client) notFound();

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
              <a href="#notes" className={buttonClass('primary', 'sm')}>
                <IconPlus size={14} />
                Add note
              </a>
            ) : null}
          </>
        }
      />

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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(19rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
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
            <CardHeader title="Contacts" />
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">
              <IconUser size={14} className="mr-1 inline align-[-2px]" />
              {client.billingEmail ? `Billing: ${client.billingEmail}` : 'No billing contact on file.'}
            </p>
          </Card>

          <ActivityFeed title="Client timeline" items={timeline} emptyTitle="Nothing recorded yet" compact />
        </div>
      </div>
    </div>
  );
}
