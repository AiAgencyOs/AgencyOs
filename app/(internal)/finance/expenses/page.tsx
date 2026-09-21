import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listExpenses } from '@/modules/finance/queries';
import { listProjects } from '@/modules/projects/queries';
import { DataTable, EmptyState, IconInvoices, PageHeader, StatGrid, Stat, type Column } from '@/ui';

import { RecordExpenseForm } from './expense-form';

export const metadata: Metadata = { title: 'Expenses' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

type Row = Awaited<ReturnType<typeof listExpenses>>[number];

const columnsFor = (clock: AgencyClock, projectName: (id: string | null) => string): Column<Row>[] => [
  { key: 'description', header: 'What', primary: true, cell: (e) => e.description },
  { key: 'category', header: 'Category', badge: true, cell: (e) => e.category },
  { key: 'vendor', header: 'Vendor', cellClassName: 'text-muted', cell: (e) => e.vendor ?? '—' },
  { key: 'project', header: 'Project', cellClassName: 'text-muted', cell: (e) => projectName(e.projectId) },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    cellClassName: 'tabular font-medium',
    cell: (e) => money(e.amountMinor, e.currency),
  },
  {
    key: 'incurred',
    header: 'Incurred',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (e) => clock.date(e.incurredOn),
  },
];

/**
 * Expenses & Profitability — SCR-055. Never client-visible (business rules
 * §19); RLS (finance.expenses_select) already refuses anyone but owner,
 * ops_admin or the finance role before this page runs a single query.
 * Recording is owner/ops_admin only — the finance role reads, per G-314's
 * whole point, and does not write.
 *
 * Deliberately no profitability/margin computation yet: that needs revenue
 * attributed to the same project over the same window, and this is the
 * first release of the underlying cost data — margin math belongs in its
 * own pass once there is real data to check it against.
 */
export default async function ExpensesPage() {
  const context = await requireInternal('/finance/expenses');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) redirect('/finance');

  const [expenses, projects] = await Promise.all([listExpenses(), listProjects(500)]);
  const canRecord = can(context.role, 'invoice.issue');

  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
  const projectName = (id: string | null) => (id ? (projectNameById.get(id) ?? 'Unknown project') : 'Overhead');

  const byCurrency = new Map<string, number>();
  for (const e of expenses) byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + e.amountMinor);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Expenses"
        description={
          expenses.length === 0
            ? 'No expenses recorded yet.'
            : `${expenses.length} expense${expenses.length === 1 ? '' : 's'} recorded.`
        }
      />

      {byCurrency.size > 0 ? (
        <StatGrid>
          {[...byCurrency.entries()].map(([currency, total]) => (
            <Stat key={currency} label={`Total (${currency})`} value={money(total, currency)} />
          ))}
        </StatGrid>
      ) : null}

      {canRecord ? <RecordExpenseForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} /> : null}

      {expenses.length > 0 ? (
        <DataTable rows={expenses} columns={columnsFor(clock, projectName)} getKey={(e) => e.id} />
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title="No expenses yet"
          description="Infrastructure, AI, tooling, vendor and contractor costs recorded here."
        />
      )}
    </div>
  );
}
