import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listExpenses, listInvoices } from '@/modules/finance/queries';
import { readAiCostByProject } from '@/modules/finance/ai-cost-queries';
import { listProjects } from '@/modules/projects/queries';
import { SavedViewsBar } from '../../saved-views-bar';
import {
  Card,
  CardHeader,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  IconInvoices,
  paginate,
  Pagination,
  PageHeader,
  StatGrid,
  Stat,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
  buttonClass,
  TrendChart,
} from '@/ui';

import { EditExpenseForm } from './expense-edit';
import { RecordExpenseForm } from './expense-form';

export const metadata: Metadata = { title: 'Expenses' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

type Row = Awaited<ReturnType<typeof listExpenses>>[number];

const columnsFor = (
  clock: AgencyClock,
  projectName: (id: string | null) => string,
  editable: boolean,
  projects: readonly { id: string; name: string }[],
): Column<Row>[] => [
  { key: 'description', header: 'What', primary: true, cell: (e) => e.description },
  { key: 'category', header: 'Category', badge: true, cell: (e) => e.category },
  { key: 'vendor', header: 'Vendor', cellClassName: 'text-muted', cell: (e) => e.vendor ?? '—' },
  {
    key: 'receipt',
    header: 'Receipt',
    desktopOnly: true,
    cell: (e) =>
      e.receiptUrl ? (
        <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand hover:underline">
          Open
        </a>
      ) : (
        <span className="text-xs text-muted">—</span>
      ),
  },
  { key: 'project', header: 'Project', cellClassName: 'text-muted', cell: (e) => projectName(e.projectId) },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    cellClassName: 'tabular font-medium',
    cell: (e) => money(e.amountMinor, e.currency),
    sortKey: 'amount',
  },
  {
    key: 'incurred',
    header: 'Incurred',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (e) => clock.date(e.incurredOn),
    sortKey: 'incurred',
  },
  ...(editable
    ? [{ key: 'edit', header: '', align: 'right' as const, desktopOnly: true, cell: (e: Row) => <EditExpenseForm expense={e} projects={projects} /> }]
    : []),
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  amount: (a, b) => a.amountMinor - b.amountMinor,
  incurred: (a, b) => a.incurredOn.localeCompare(b.incurredOn),
};

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
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string }>;
}) {
  const context = await requireInternal('/finance/expenses');
  const clock = await agencyClock();
  if (!can(context, 'invoice.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = sortKey ? `sort=${sortKey}&dir=${direction}` : '';
  const [rawExpenses, projects, invoices, savedViews, aiCosts] = await Promise.all([
    listExpenses(),
    listProjects(500),
    listInvoices(500),
    listSavedViews('/finance/expenses'),
    readAiCostByProject(),
  ]);
  // AI / tooling cost — what the runtime recorded against each project
  // (`ai.agent_runs.cost_minor`, attributed by project). Shown beside the
  // recorded expenses, not added to them: an `ai` expense somebody typed in
  // and a run the runtime priced may be the same rupee twice, and only a
  // person can say which.
  const aiByProject = new Map(aiCosts.map((c) => [c.projectId, c]));
  const expenses = sortRows(rawExpenses, sortKey, direction, COMPARATORS);
  const canRecord = can(context, 'invoice.issue');
  const { page, pageCount, rows: pageRows } = paginate(expenses, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

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

  // Monthly trend, last twelve months with activity, in the currency most
  // rows carry — a chart summing currencies would be a number that is not an
  // amount of anything.
  const currencyCounts = new Map<string, number>();
  for (const e of rawExpenses) currencyCounts.set(e.currency, (currencyCounts.get(e.currency) ?? 0) + 1);
  const trendCurrency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const byMonth = new Map<string, number>();
  for (const e of rawExpenses) {
    if (e.currency !== trendCurrency) continue;
    const month = e.incurredOn.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + e.amountMinor);
  }
  const trend = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([month, minor]) => ({
      month: new Date(`${month}-15T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      expenses: minor / 100,
    }));

  const projectIdsWithActivity = new Set([...expensesByProject.keys(), ...invoicedByProject.keys(), ...aiByProject.keys()]);
  const byProject = projects
    .filter((p) => projectIdsWithActivity.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      currency: p.currency,
      invoicedMinor: invoicedByProject.get(p.id) ?? 0,
      paidMinor: paidByProject.get(p.id) ?? 0,
      expensesMinor: expensesByProject.get(p.id) ?? 0,
      aiCostMinor: aiByProject.get(p.id)?.costMinor ?? 0,
      aiRuns: aiByProject.get(p.id)?.runs ?? 0,
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
        actions={
          <a href="/api/finance/expenses/export" className={buttonClass('secondary', 'sm')}>
            Download CSV
          </a>
        }
      />

      <SavedViewsBar page="/finance/expenses" currentQuery={currentQuery} views={savedViews} />

      {trend.length > 0 && trendCurrency ? (
        <Card>
          <CardHeader title="Monthly trend" description={`Recorded expenses per month, ${trendCurrency} only, last ${trend.length} month${trend.length === 1 ? '' : 's'} with activity.`} />
          <div className="p-4 sm:p-5">
            <TrendChart data={trend} xKey="month" series={[{ key: 'expenses', label: 'Expenses', color: 'var(--danger)' }]} currency={trendCurrency} height={200} />
          </div>
        </Card>
      ) : null}

      {byCurrency.size > 0 ? (
        <StatGrid>
          {[...byCurrency.entries()].map(([currency, total]) => (
            <Stat key={currency} label={`Total (${currency})`} value={money(total, currency)} icon={<IconInvoices size={16} />} />
          ))}
        </StatGrid>
      ) : null}

      {byProject.length > 0 ? (
        <Card>
          <CardHeader
            title="By project"
            description="Invoiced, paid, recorded expenses and what the AI runtime recorded, side by side. Not a margin — see this page's own note for why."
          />
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-normal sm:px-5">Project</th>
                <th className="px-4 py-2 text-right font-normal">Invoiced</th>
                <th className="px-4 py-2 text-right font-normal">Paid</th>
                <th className="px-4 py-2 text-right font-normal">Expenses</th>
                <th className="px-4 py-2 text-right font-normal sm:pr-5">AI / tooling (recorded runs)</th>
              </tr>
            </thead>
            <tbody>
              {byProject.map((p) => (
                <tr key={p.id} className="border-b border-line">
                  <td className="px-4 py-2 font-medium sm:px-5">{p.name}</td>
                  <td className="px-4 py-2 text-right tabular">{money(p.invoicedMinor, p.currency)}</td>
                  <td className="px-4 py-2 text-right tabular">{money(p.paidMinor, p.currency)}</td>
                  <td className="px-4 py-2 text-right tabular">{money(p.expensesMinor, p.currency)}</td>
                  <td className="px-4 py-2 text-right tabular text-muted sm:pr-5">
                    {p.aiRuns > 0 ? `${money(p.aiCostMinor, 'INR')} · ${p.aiRuns} run${p.aiRuns === 1 ? '' : 's'}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {canRecord ? <RecordExpenseForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} /> : null}

      {expenses.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock, projectName, canRecord, projects.map((p) => ({ id: p.id, name: p.name })))}
            getKey={(e) => e.id}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) => `/finance/expenses?sort=${key}&dir=${nextDirection}`,
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => `/finance/expenses?${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`}
          />
        </>
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
