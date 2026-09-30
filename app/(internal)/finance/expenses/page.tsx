import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { normaliseSearch } from '@/lib/db/search';
import { can } from '@/lib/authz/permissions';
import { listExpenses, listInvoices } from '@/modules/finance/queries';
import { readAiCostByProject } from '@/modules/finance/ai-cost-queries';
import { readBudgetVarianceByProject } from '@/modules/finance/budget-variance-queries';
import { rollupByVendor } from '@/modules/finance/vendor-rollup';
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
  DomainSearch,
  SearchSummary,
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
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; q?: string }>;
}) {
  const context = await requireInternal('/finance/expenses');
  const clock = await agencyClock();
  if (!can(context, 'invoice.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir, q: qRaw } = await searchParams;
  // Search within domain (bucket G-3): vendor, description or category, filtered by the reader.
  const q = normaliseSearch(qRaw);
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = [q ? `q=${encodeURIComponent(q)}` : '', sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const [rawExpenses, projects, invoices, savedViews, aiCosts, budgetVariance] = await Promise.all([
    listExpenses(500, q || undefined),
    listProjects(500),
    listInvoices(500),
    listSavedViews('/finance/expenses'),
    readAiCostByProject(),
    // Budget vs actual — decision F5 of 2026-09-30 (reopened). One pure
    // function (computeBudgetVariance) serves this table and the project report.
    readBudgetVarianceByProject(),
  ]);
  // SCR-055: vendor / tool rollup — one line per vendor per currency.
  const vendors = rollupByVendor(rawExpenses);
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

      {budgetVariance.length > 0 ? (
        <Card>
          <CardHeader
            title="Budget vs actual"
            description="Decision F5 (2026-09-30): each project's budget against expenses + AI cost + time cost, the variance, and the average monthly burn over months with any cost. Time is costed at each person's day-of-log rate; uncosted hours are said, not zeroed."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-normal sm:px-5">Project</th>
                  <th className="px-4 py-2 text-right font-normal">Budget</th>
                  <th className="px-4 py-2 text-right font-normal">Actual</th>
                  <th className="px-4 py-2 text-right font-normal">Variance</th>
                  <th className="px-4 py-2 text-right font-normal">Consumed</th>
                  <th className="px-4 py-2 text-right font-normal">Margin (cash-basis estimate)</th>
                  <th className="px-4 py-2 text-right font-normal sm:pr-5">Monthly burn</th>
                </tr>
              </thead>
              <tbody>
                {budgetVariance.map((v) => (
                  <tr key={v.projectId} className="border-b border-line">
                    <td className="px-4 py-2 font-medium sm:px-5">
                      <a href={`/projects/${v.projectId}/reports`} className="hover:underline">{v.name}</a>
                      {v.uncostedHours > 0 ? <span className="ml-2 text-xs text-warning">{v.uncostedHours} h uncosted</span> : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular">{v.budgetMinor !== null ? money(v.budgetMinor, v.currency) : <span className="text-muted">no budget</span>}</td>
                    <td className="px-4 py-2 text-right tabular">{money(v.actualMinor, v.currency)}</td>
                    <td className={`px-4 py-2 text-right tabular ${v.standing === 'over' ? 'text-danger' : v.standing === 'under' ? 'text-success' : 'text-muted'}`}>
                      {v.varianceMinor !== null ? `${v.varianceMinor < 0 ? '−' : ''}${money(Math.abs(v.varianceMinor), v.currency)} (${v.variancePercent}%)` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular">{v.consumedPercent !== null ? `${v.consumedPercent}%` : '—'}</td>
                    {/* SCR-055: paid − (expenses + AI cost + time cost), the same arithmetic as the project report's margin. */}
                    <td className={`px-4 py-2 text-right tabular ${(paidByProject.get(v.projectId) ?? 0) - v.actualMinor < 0 ? 'text-danger' : ''}`}>
                      {money((paidByProject.get(v.projectId) ?? 0) - v.actualMinor, v.currency)}
                    </td>
                    <td className="px-4 py-2 text-right tabular text-muted sm:pr-5">
                      {v.averageBurnMinor > 0 ? `${money(v.averageBurnMinor, v.currency)} / month${v.monthsLeftAtBurn !== null ? ` · ${v.monthsLeftAtBurn} left` : ''}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {vendors.length > 0 ? (
        <Card>
          <CardHeader title="By vendor / tool" description="Every vendor the expenses name, per currency, with the categories it was recorded under. A rollup of recorded rows, not a contract list." />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-normal sm:px-5">Vendor</th>
                  <th className="px-4 py-2 font-normal">Categories</th>
                  <th className="px-4 py-2 text-right font-normal">Expenses</th>
                  <th className="px-4 py-2 text-right font-normal">Last incurred</th>
                  <th className="px-4 py-2 text-right font-normal sm:pr-5">Total</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v) => (
                  <tr key={`${v.vendor}|${v.currency}`} className="border-b border-line">
                    <td className="px-4 py-2 font-medium sm:px-5">{v.vendor}</td>
                    <td className="px-4 py-2 text-muted">{v.categories.join(', ')}</td>
                    <td className="px-4 py-2 text-right tabular text-muted">{v.count}</td>
                    <td className="px-4 py-2 text-right text-muted">{clock.date(v.lastIncurredOn)}</td>
                    <td className="px-4 py-2 text-right tabular font-medium sm:pr-5">{money(v.totalMinor, v.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {canRecord ? <RecordExpenseForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} /> : null}

      {/* Search within domain (bucket G-3): vendor, description or category, filtered by the reader. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <DomainSearch action="/finance/expenses" value={q} placeholder="Search vendor, description or category…" label="Search expenses" preserve={{ sort: sortKey, dir }} />
        <SearchSummary q={q} count={expenses.length} clearHref={sortKey ? `/finance/expenses?sort=${sortKey}&dir=${direction}` : '/finance/expenses'} />
      </div>

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
          title={q ? 'No matching expenses' : 'No expenses yet'}
          description={q ? `No expense matches ‘${q}’ on vendor, description or category.` : 'Infrastructure, AI, tooling, vendor and contractor costs recorded here.'}
          action={q ? <a href="/finance/expenses" className={buttonClass('secondary', 'sm')}>Clear search</a> : canRecord ? <a href="#record-expense" className={buttonClass('secondary', 'sm')}>Record an expense</a> : <a href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</a>}
        />
      )}
    </div>
  );
}
