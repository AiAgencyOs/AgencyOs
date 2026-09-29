import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPendingPaymentClaims } from '@/modules/finance/queries';
import {
  listBillableMilestones,
  listBillingClients,
  listInvoicesFiltered,
} from '@/modules/finance/overview-queries';
import { milestoneInvoiceability } from '@/modules/finance/schema';
import { listProjects } from '@/modules/projects/queries';
import {
  Callout,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  FilterBar,
  IconAlert,
  IconInvoices,
  PageHeader,
  StatusBadge,
  buttonClass,
  labelClass,
  selectClass,
  type Column,
} from '@/ui';

import { CreateFromMilestoneForm } from './create-from-milestone-form';

export const metadata: Metadata = { title: 'Invoices' };

/** Minor units → display string, in the currency the invoice was raised in. */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listInvoicesFiltered>>[number];

const columnsFor = (clock: AgencyClock, clientName: (id: string) => string): Column<Row>[] => [
  {
    key: 'number',
    header: 'Number',
    primary: true,
    cellClassName: 'font-mono text-xs',
    cell: (i) => i.number,
  },
  { key: 'status', header: 'Status', badge: true, cell: (i) => <StatusBadge status={i.status} /> },
  { key: 'client', header: 'Client', cellClassName: 'text-muted', cell: (i) => clientName(i.client_account_id) },
  {
    key: 'total',
    header: 'Total',
    align: 'right',
    cellClassName: 'tabular font-medium',
    cell: (i) => money(i.total_minor, i.currency),
  },
  {
    key: 'paid',
    header: 'Paid',
    align: 'right',
    cellClassName: 'tabular text-muted',
    cell: (i) => money(i.paid_minor, i.currency),
  },
  {
    key: 'issued',
    header: 'Issued',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (i) => (i.issued_at ? clock.date(i.issued_at) : '—'),
  },
  {
    key: 'due',
    header: 'Due',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (i) => (i.due_at ? clock.date(i.due_at) : '—'),
  },
];

/**
 * Invoice list — SCR-051.
 *
 * Same two-layer gate as the leads page: the capability is re-checked because
 * hiding the nav entry is not access control, and RLS refuses the rows
 * independently of both. Client and project filters round-trip through the
 * URL and are applied by the reader at the database.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; project?: string }>;
}) {
  const context = await requireInternal('/invoices');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) redirect('/dashboard');

  const { client: clientId, project: projectId } = await searchParams;
  const filtered = Boolean(clientId || projectId);
  const canIssue = can(context.role, 'invoice.issue');
  const canCreate = can(context.role, 'invoice.create');

  const [invoices, pendingClaims, clients, projects, milestones, everyInvoice] = await Promise.all([
    listInvoicesFiltered({ clientId, projectId }),
    canIssue ? listPendingPaymentClaims() : Promise.resolve([]),
    listBillingClients(),
    listProjects(500),
    canCreate ? listBillableMilestones() : Promise.resolve([]),
    canCreate ? listInvoicesFiltered({}, 2000) : Promise.resolve([]),
  ]);

  const clientById = new Map(clients.map((c) => [c.id, c.name]));
  const clientName = (id: string) => clientById.get(id) ?? 'Unknown client';

  // Eligible = the shared rule says it may be billed AND no invoice names it
  // yet. The service re-decides both; this only keeps the picker honest.
  const invoicedMilestones = new Set(everyInvoice.map((i) => i.milestone_id).filter((id): id is string => id !== null));
  const eligible = milestones
    .filter((m) => !invoicedMilestones.has(m.id))
    .filter((m) => milestoneInvoiceability({ status: m.status, amountMinor: m.amountMinor, paymentPercent: m.paymentPercent }).ok)
    .map((m) => ({
      id: m.id,
      projectId: m.projectId,
      name: m.name,
      position: m.position,
      amountLabel: money(m.amountMinor, m.currency),
    }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Invoices"
        description={
          invoices.length === 0
            ? filtered
              ? 'No invoices match these filters.'
              : 'No invoices raised yet.'
            : `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}${filtered ? ' matching the filters' : ''}.`
        }
      />

      {pendingClaims.length > 0 ? (
        <Callout tone="warning" icon={<IconAlert size={16} />}>
          <span className="flex flex-wrap items-center gap-2">
            {pendingClaims.length} payment claim{pendingClaims.length === 1 ? '' : 's'} awaiting a decision.
            <Link href="/invoices/verify" className="font-medium underline underline-offset-2">
              Open the verification queue
            </Link>
          </span>
        </Callout>
      ) : null}

      <form action="/invoices" method="GET">
        <FilterBar>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="invoices-client">
              Client
            </label>
            <select id="invoices-client" name="client" defaultValue={clientId ?? ''} className={`${selectClass} sm:w-52`}>
              <option value="">Every client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="invoices-project">
              Project
            </label>
            <select id="invoices-project" name="project" defaultValue={projectId ?? ''} className={`${selectClass} sm:w-52`}>
              <option value="">Every project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className={buttonClass('primary', 'sm')}>
              Apply
            </button>
            {filtered ? (
              <Link href="/invoices" className={buttonClass('ghost', 'sm')}>
                Clear
              </Link>
            ) : null}
          </div>
        </FilterBar>
      </form>

      {canCreate ? (
        <Card>
          <CardHeader
            title="Create from a milestone"
            description="A draft, from a milestone the payment plan says may be billed and nothing has invoiced yet. Issuing it is a separate step on the invoice."
          />
          <div className="px-4 pb-4 sm:px-5">
            <CreateFromMilestoneForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} milestones={eligible} />
          </div>
        </Card>
      ) : null}

      {invoices.length > 0 ? (
        <DataTable
          rows={invoices}
          columns={columnsFor(clock, clientName)}
          getKey={(i) => i.id}
          href={(i) => `/invoices/${i.id}`}
        />
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title={filtered ? 'No matching invoices' : 'No invoices yet'}
          description={
            filtered
              ? 'Nothing was raised for this client or project.'
              : 'Invoices raised against project milestones will appear here.'
          }
        />
      )}
    </div>
  );
}
