import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { normaliseSearch } from '@/lib/db/search';
import { can } from '@/lib/authz/permissions';
import { listExpenses, listInvoices } from '@/modules/finance/queries';
import { readAiCostByAgent } from '@/modules/finance/ai-cost-queries';
import { filterExpenses, projectProfitability, type ProjectCosts } from '@/modules/finance/project-profitability';
import { EXPENSE_CATEGORIES } from '@/modules/finance/schema';
import { financeBasis, principalCurrency } from '@/modules/finance/verified-basis';
import { readBudgetVarianceByProject } from '@/modules/finance/budget-variance-queries';
import { rollupByVendor } from '@/modules/finance/vendor-rollup';
import { listProjects } from '@/modules/projects/queries';
import { SavedViewsBar } from '../../saved-views-bar';
import {
  Card,
  CardHeader,
  DataTable,
  FilterBar,
  humanize,
  inputClass,
  labelClass,
  selectClass,
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
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; q?: string; category?: string; project?: string; vendor?: string; from?: string; to?: string }>;
}) {
  const context = await requireInternal('/finance/expenses');
  const clock = await agencyClock();
  if (!can(context, 'invoice.read')) return <PermissionDenied />;

  const raw = await searchParams;
  const { page: pageParam, sort: sortKey, dir, q: qRaw } = raw;
  // SCR-055 filters: category, project (or overhead), vendor, date range — from the URL, like every list here.
  const dayShape = /^\d{4}-\d{2}-\d{2}$/;
  const expenseFilter = {
    category: (EXPENSE_CATEGORIES as readonly string[]).includes(raw.category ?? '') ? raw.category : undefined,
    project: raw.project === 'none' || /^[0-9a-f-]{36}$/i.test(raw.project ?? '') ? raw.project : undefined,
    vendor: raw.vendor?.trim() || undefined,
    from: raw.from && dayShape.test(raw.from) ? raw.from : undefined,
    to: raw.to && dayShape.test(raw.to) ? raw.to : undefined,
  };
  const filterActive = Boolean(expenseFilter.category || expenseFilter.project || expenseFilter.vendor || expenseFilter.from || expenseFilter.to);
  const filterQuery = Object.entries(expenseFilter).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  // Search within domain (bucket G-3): vendor, description or category, filtered by the reader.
  const q = normaliseSearch(qRaw);
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = [q ? `q=${encodeURIComponent(q)}` : '', filterQuery, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const [everyExpense, projects, invoices, savedViews, budgetVariance, aiByAgent] = await Promise.all([
    listExpenses(500, q || undefined),
    listProjects(500),
    listInvoices(500),
    listSavedViews('/finance/expenses'),
    // Budget vs actual — decision F5 of 2026-09-30 (reopened). One pure
    // function (computeBudgetVariance) serves this table and the project report.
    readBudgetVarianceByProject(),
    readAiCostByAgent(),
  ]);
  const rawExpenses = filterExpenses(everyExpense, expenseFilter);
  // SCR-055: vendor / tool rollup — one line per vendor per currency.
  const vendors = rollupByVendor(rawExpenses);
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
    // verified, not recorded: the one basis every finance total uses (verified-basis.ts)
    paidByProject.set(i.project_id, (paidByProject.get(i.project_id) ?? 0) + (['issued', 'partially_paid', 'paid', 'overdue'].includes(i.status) ? Math.min(i.verified_minor, i.total_minor) : 0));
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

  // ONE margin definition (project-profitability.ts): verified revenue less
  // expenses, AI cost and time cost — whole books, not narrowed by the filters
  // below, so the same project reads the same here, in the project report and
  // (one level up, without the AI and time terms) in Net Profit on the overview.
  const costsByProject = new Map<string, ProjectCosts>(
    budgetVariance.map((v) => [v.projectId, { expensesMinor: v.expensesMinor, aiCostMinor: v.aiCostMinor, timeCostMinor: v.timeCostMinor, uncostedHours: v.uncostedHours }]),
  );
  const profitability = projectProfitability({
    projects: projects.map((p) => ({ id: p.id, name: p.name, currency: p.currency })),
    invoices: invoices.map((i) => ({ id: i.id, status: i.status, currency: i.currency, total_minor: i.total_minor, paid_minor: i.paid_minor, verified_minor: i.verified_minor, project_id: i.project_id })),
    costs: costsByProject,
  });
  const basisCurrency = principalCurrency(invoices.map((i) => ({ id: i.id, status: i.status, currency: i.currency, total_minor: i.total_minor, paid_minor: i.paid_minor, verified_minor: i.verified_minor, project_id: i.project_id })), trendCurrency ?? 'INR');
  const basis = financeBasis({
    invoices: invoices.map((i) => ({ id: i.id, status: i.status, currency: i.currency, total_minor: i.total_minor, paid_minor: i.paid_minor, verified_minor: i.verified_minor, project_id: i.project_id })),
    expenses: everyExpense,
    currency: basisCurrency,
  });
  const marginTotal = profitability.filter((r) => r.currency === basisCurrency).reduce((n, r) => n + r.margin.marginMinor, 0);
  const withBudget = budgetVariance.filter((v) => v.budgetMinor !== null && v.currency === basisCurrency);
  const budgetTotal = withBudget.reduce((n, v) => n + (v.budgetMinor ?? 0), 0);
  const budgetActual = withBudget.reduce((n, v) => n + v.actualMinor, 0);
  const categoryTotals = new Map<string, number>();
  for (const e of expenses) if (e.currency === basisCurrency) categoryTotals.set(e.category, (categoryTotals.get(e.category) ?? 0) + e.amountMinor);
  const topCategory = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  const exportHref = `/api/finance/expenses/export${filterQuery ? `?${filterQuery}` : ''}`;
  const keepForLinks = [q ? `q=${encodeURIComponent(q)}` : '', filterQuery].filter(Boolean).join('&');

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
          <a href={exportHref} className={buttonClass('secondary', 'sm')}>
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

      {/* SCR-055's header: total expenses, project margin, cost categories, budget vs actual — one row, each a number from stored rows. */}
      <StatGrid cols={4}>
        <Stat label="Total Expenses" value={money(expenses.filter((e) => e.currency === basisCurrency).reduce((n, e) => n + e.amountMinor, 0), basisCurrency)} caption={`${expenses.length} recorded${filterActive || q ? ' in this filter' : ''}${byCurrency.size > 1 ? ` · other currencies: ${[...byCurrency.keys()].filter((c) => c !== basisCurrency).join(', ')}` : ''}`} tone="danger" icon={<IconInvoices size={16} />} />
        <Stat label="Project Margin" value={money(marginTotal, basisCurrency)} caption={`verified revenue less expenses, AI and time cost · net profit before AI and time ${money(basis.netMinor, basisCurrency)}`} tone={marginTotal >= 0 ? 'success' : 'danger'} icon={<IconInvoices size={16} />} href="#profitability" />
        <Stat label="Cost Categories" value={String(categoryTotals.size)} caption={topCategory ? `largest: ${humanize(topCategory[0])} ${money(topCategory[1], basisCurrency)}` : 'nothing recorded'} tone="info" icon={<IconInvoices size={16} />} href="#expense-list" />
        <Stat label="Budget vs Actual" value={budgetTotal > 0 ? `${Math.round((budgetActual / budgetTotal) * 1000) / 10}%` : '—'} caption={budgetTotal > 0 ? `${money(budgetActual, basisCurrency)} of ${money(budgetTotal, basisCurrency)} budgeted (${withBudget.length} project${withBudget.length === 1 ? '' : 's'})` : 'no project has a budget recorded'} tone={budgetTotal > 0 && budgetActual > budgetTotal ? 'danger' : 'neutral'} icon={<IconInvoices size={16} />} href="#budget-vs-actual" />
      </StatGrid>

      {/* Project profitability — the single margin definition, per project. */}
      <Card id="profitability">
        <CardHeader
          title="Project Profitability"
          description="Verified revenue less recorded expenses, AI cost and time cost, per project — the same margin the project report shows, on the same verified basis as Finance Overview. Whole books: not narrowed by the filters below."
        />
        {profitability.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-normal sm:px-5">Project</th>
                  <th className="px-4 py-2 text-right font-normal">Invoiced</th>
                  <th className="px-4 py-2 text-right font-normal">Verified revenue</th>
                  <th className="px-4 py-2 text-right font-normal">Expenses</th>
                  <th className="px-4 py-2 text-right font-normal">AI</th>
                  <th className="px-4 py-2 text-right font-normal">Time</th>
                  <th className="px-4 py-2 text-right font-normal sm:pr-5">Margin</th>
                </tr>
              </thead>
              <tbody>
                {profitability.map((r) => (
                  <tr key={r.projectId} className="border-b border-line">
                    <td className="px-4 py-2 font-medium sm:px-5">
                      <a href={`/projects/${r.projectId}/reports`} className="hover:underline">{r.name}</a>
                      {r.margin.uncostedHours > 0 ? <span className="ml-2 text-xs text-warning">{r.margin.uncostedHours} h uncosted</span> : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular">{money(r.invoicedMinor, r.currency)}</td>
                    <td className="px-4 py-2 text-right tabular">{money(r.margin.paidMinor, r.currency)}</td>
                    <td className="px-4 py-2 text-right tabular">{money(r.margin.expensesMinor, r.currency)}</td>
                    <td className="px-4 py-2 text-right tabular">{money(r.margin.aiCostMinor, 'INR')}</td>
                    <td className="px-4 py-2 text-right tabular">{money(r.margin.timeCostMinor, 'INR')}</td>
                    <td className={`px-4 py-2 text-right tabular font-medium sm:pr-5 ${r.margin.marginMinor < 0 ? 'text-danger' : ''}`}>
                      {money(r.margin.marginMinor, r.currency)}
                      {r.margin.marginPercent !== null ? <span className="ml-1 text-xs text-muted">({r.margin.marginPercent}%)</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No project has verified revenue or recorded cost yet.</p>
        )}
      </Card>

      {/* AI / tooling costs — what the runtime recorded, by agent. Totals only: no model, prompt or output. */}
      {aiByAgent.length > 0 ? (
        <Card id="ai-costs">
          <CardHeader title="AI / Tooling Costs" description="What the AI runtime recorded, by agent — runs, tokens and cost. Shown beside expenses, never added to them: an AI expense somebody typed in and a run the runtime priced may be the same rupee." />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-normal sm:px-5">Agent</th>
                  <th className="px-4 py-2 text-right font-normal">Runs</th>
                  <th className="px-4 py-2 text-right font-normal">Projects</th>
                  <th className="px-4 py-2 text-right font-normal">Tokens (in / out)</th>
                  <th className="px-4 py-2 text-right font-normal sm:pr-5">Recorded cost</th>
                </tr>
              </thead>
              <tbody>
                {aiByAgent.map((a) => (
                  <tr key={a.agentKey} className="border-b border-line">
                    <td className="px-4 py-2 font-medium sm:px-5">{humanize(a.agentKey)}</td>
                    <td className="px-4 py-2 text-right tabular text-muted">{a.runs}</td>
                    <td className="px-4 py-2 text-right tabular text-muted">{a.projects}</td>
                    <td className="px-4 py-2 text-right tabular text-muted">{a.inputTokens.toLocaleString('en-IN')} / {a.outputTokens.toLocaleString('en-IN')}</td>
                    <td className="px-4 py-2 text-right tabular font-medium sm:pr-5">{money(a.costMinor, 'INR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {budgetVariance.length > 0 ? (
        <Card id="budget-vs-actual">
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
                  <th className="px-4 py-2 text-right font-normal">Margin (verified, cash basis)</th>
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

      {/* Search within domain (bucket G-3) plus SCR-055's filters: category, project, vendor, date range. */}
      <FilterBar clearHref="/finance/expenses" filtered={filterActive || Boolean(q)}>
        <DomainSearch action="/finance/expenses" value={q} placeholder="Search vendor, description or category…" label="Search expenses" preserve={{ sort: sortKey, dir, category: expenseFilter.category, project: expenseFilter.project, vendor: expenseFilter.vendor, from: expenseFilter.from, to: expenseFilter.to }} />
        <SearchSummary q={q} count={expenses.length} clearHref={sortKey ? `/finance/expenses?sort=${sortKey}&dir=${direction}` : '/finance/expenses'} />
        <form method="get" action="/finance/expenses" className="flex flex-wrap items-end gap-2">
          {q ? <input type="hidden" name="q" value={q} /> : null}
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="exp-category">Category</label>
            <select id="exp-category" name="category" defaultValue={expenseFilter.category ?? ''} className={`${selectClass} sm:w-40`}>
              <option value="">Every category</option>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{humanize(c)}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="exp-project">Project</label>
            <select id="exp-project" name="project" defaultValue={expenseFilter.project ?? ''} className={`${selectClass} sm:w-44`}>
              <option value="">Every project</option>
              <option value="none">Overhead — no project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="exp-vendor">Vendor</label>
            <input id="exp-vendor" name="vendor" defaultValue={expenseFilter.vendor ?? ''} placeholder="Vendor name" className={`${inputClass} sm:w-36`} />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="exp-from">From</label>
            <input id="exp-from" type="date" name="from" defaultValue={expenseFilter.from ?? ''} className={`${inputClass} sm:w-36`} />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="exp-to">To</label>
            <input id="exp-to" type="date" name="to" defaultValue={expenseFilter.to ?? ''} className={`${inputClass} sm:w-36`} />
          </div>
          <button type="submit" className={buttonClass('secondary', 'sm')}>Apply</button>
        </form>
      </FilterBar>

      {expenses.length > 0 ? (
        <div id="expense-list" className="flex flex-col gap-5">
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock, projectName, canRecord, projects.map((p) => ({ id: p.id, name: p.name })))}
            getKey={(e) => e.id}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) => `/finance/expenses?${keepForLinks ? `${keepForLinks}&` : ''}sort=${key}&dir=${nextDirection}`,
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => `/finance/expenses?${keepForLinks ? `${keepForLinks}&` : ''}${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`}
          />
        </div>
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title={q || filterActive ? 'No matching expenses' : 'No expenses yet'}
          description={q || filterActive ? 'No expense matches these filters.' : 'Infrastructure, AI, tooling, vendor and contractor costs recorded here.'}
          action={q || filterActive ? <a href="/finance/expenses" className={buttonClass('secondary', 'sm')}>Clear search and filters</a> : canRecord ? <a href="#record-expense" className={buttonClass('secondary', 'sm')}>Record an expense</a> : <a href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</a>}
        />
      )}
    </div>
  );
}
