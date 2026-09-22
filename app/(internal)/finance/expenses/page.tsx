import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listExpenses, listInvoices } from '@/modules/finance/queries';
import { listProjects } from '@/modules/projects/queries';
import { Card, CardHeader, DataTable, EmptyState, IconInvoices, PageHeader, StatGrid, Stat, type Column } from '@/ui';

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
 * Deliberately no profitability/margin computation — that is a real
 * accounting decision (does it net overhead? which costs are shared across
 * projects and how are they split?) this pass does not make unilaterally.
 * The "By project" section below is not that: it is invoiced and expense
 * totals, each already correct and already shown elsewhere in the product,
 * placed side by side. No subtraction, no percentage, no derived figure —
 * a reader who wants a margin does the arithmetic themselves, informed
 * rather than told.
 */
export default async function ExpensesPage() {
  const context = await requireInternal('/finance/expenses');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) redirect('/finance');

  const [expenses, projects, invoices] = await Promise.all([listExpenses(), listProjects(500), listInvoices(500)]);
  const canRecord = can(context.role, 'invoice.issue');

  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
  const projectName = (id: string | null) => (id ? (projectNameById.get(id) ?? 'Unknown project') : 'Overhead');

  const byCurrency = new Map<string, number>();
  for (const e of expenses) byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + e.amountMinor);

  const expensesByProject = new Map<string, number>();
  for (const e of expenses) {
    if (!e.projectId) continue;
    expensesByProject.set(e.projectId, (expensesByProject.get(e.projectId) ?? 0) + e.amountMinor);
  }

  const invoicedByProject = new Map<string, number>();
  const paidByProject = new Map<string, number>();
  for (const i of invoices) {
    if (!i.project_id) continue;
    invoicedByProject.set(i.project_id, (invoicedByProject.get(i.project_id) ?? 0) + i.total_minor);
    paidByProject.set(i.project_id, (paidByProject.get(i.project_id) ?? 0) + i.paid_minor);
  }

  const projectIdsWithActivity = new Set([...expensesByProject.keys(), ...invoicedByProject.keys()]);
  const byProject = projects
    .filter((p) => projectIdsWithActivity.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      currency: p.currency,
      invoicedMinor: invoicedByProject.get(p.id) ?? 0,
      paidMinor: paidByProject.get(p.id) ?? 0,
      expensesMinor: expensesByProject.get(p.id) ?? 0,
    }));

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

      {byProject.length > 0 ? (
        <Card>
          <CardHeader
            title="By project"
            description="Invoiced, paid and recorded expenses, side by side. Not a margin — see this page's own note for why."
          />
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-normal sm:px-5">Project</th>
                <th className="px-4 py-2 text-right font-normal">Invoiced</th>
                <th className="px-4 py-2 text-right font-normal">Paid</th>
                <th className="px-4 py-2 text-right font-normal sm:pr-5">Expenses</th>
              </tr>
            </thead>
            <tbody>
              {byProject.map((p) => (
                <tr key={p.id} className="border-b border-line">
                  <td className="px-4 py-2 font-medium sm:px-5">{p.name}</td>
                  <td className="px-4 py-2 text-right tabular">{money(p.invoicedMinor, p.currency)}</td>
                  <td className="px-4 py-2 text-right tabular">{money(p.paidMinor, p.currency)}</td>
                  <td className="px-4 py-2 text-right tabular sm:pr-5">{money(p.expensesMinor, p.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
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
