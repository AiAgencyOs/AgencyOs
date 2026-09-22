import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listClients } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, DataTable, EmptyState, IconUser, PageHeader, type Column } from '@/ui';

export const metadata: Metadata = { title: 'Clients' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

type Row = Awaited<ReturnType<typeof listClients>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  { key: 'name', header: 'Client', primary: true, cell: (c) => c.name },
  {
    key: 'status',
    header: 'Status',
    badge: true,
    cell: (c) => <Badge tone={c.status === 'active' ? 'success' : 'neutral'}>{c.status}</Badge>,
  },
  {
    key: 'projects',
    header: 'Projects',
    align: 'right',
    cellClassName: 'tabular',
    cell: (c) => `${c.projectsActive} active / ${c.projectsTotal} total`,
  },
  {
    key: 'invoiced',
    header: 'Invoiced',
    align: 'right',
    cellClassName: 'tabular',
    cell: (c) => money(c.invoicedMinor, c.currency),
  },
  {
    key: 'outstanding',
    header: 'Outstanding',
    align: 'right',
    cellClassName: 'tabular font-medium',
    cell: (c) => money(c.outstandingMinor, c.currency),
  },
  {
    key: 'created',
    header: 'Since',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (c) => clock.date(c.createdAt),
  },
];

/**
 * Client registry — the PDF's Clients module (§014-017) had no admin route at
 * all: a client existed only implicitly inside a lead, a project or an
 * invoice. This is the master list; totals come from the owning modules'
 * tables (see lib/admin/clients.ts), never restated.
 *
 * Same two-layer gate as the other internal pages: the capability is
 * re-checked here because hiding the nav entry is not access control, and RLS
 * refuses the rows independently of both. Gated on project.read rather than a
 * new capability — every role that may see a project may see who it is for.
 */
export default async function ClientsPage() {
  const context = await requireInternal('/clients');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const clients = await listClients();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Clients"
        description={
          clients.length === 0
            ? 'No client accounts yet. Winning a deal on a lead creates one.'
            : `${clients.length} client account${clients.length === 1 ? '' : 's'}.`
        }
      />

      {clients.length > 0 ? (
        <DataTable rows={clients} columns={columnsFor(clock)} getKey={(c) => c.id} href={(c) => `/clients/${c.id}`} />
      ) : (
        <EmptyState
          icon={<IconUser size={22} />}
          title="No clients yet"
          description="A client account is created automatically the first time a deal is won."
        />
      )}
    </div>
  );
}
