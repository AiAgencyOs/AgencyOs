import type { Metadata } from 'next';

import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInvoices, listPendingPaymentClaims } from '@/modules/finance/queries';
import { listBillableMilestones, listBillingClients, listInvoicesFiltered } from '@/modules/finance/overview-queries';
import { INVOICE_STATUSES, milestoneInvoiceability } from '@/modules/finance/schema';
import { readInvoiceSendSummaries, type InvoiceSendSummary } from '@/modules/finance/sends-queries';
import { needsReminder } from '@/modules/finance/sends-schema';
import { listProjects } from '@/modules/projects/queries';
import { SavedViewsBar } from '../saved-views-bar';
import { CreateFromMilestoneForm } from './create-from-milestone-form';
import {
  Badge,
  Callout,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  IconAlert,
  IconInvoices,
  paginate,
  Pagination,
  PageHeader,
  StatusBadge,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
  Stat,
  StatGrid,
  FilterBar,
  FilterChips,
  IconCheck,
  IconClock,
  humanize,
  cx,
  inputClass,
  buttonClass,
  Card,
  CardHeader,
  selectClass,
} from '@/ui';

export const metadata: Metadata = { title: 'Invoices' };

/** Minor units → display string, in the currency the invoice was raised in. */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listInvoices>>[number];

const columnsFor = (clock: AgencyClock, sends: Map<string, InvoiceSendSummary>, now: Date): Column<Row>[] => [
  {
    key: 'number',
    header: 'Number',
    primary: true,
    cellClassName: 'font-mono text-xs',
    cell: (i) => i.number,
  },
  {
    key: 'status',
    header: 'Status',
    badge: true,
    cell: (i) => (
      <span className="inline-flex flex-wrap items-center gap-1">
        <StatusBadge status={i.status} />
        {/* SCR-051: issued, past due, and no reminder recorded in the last 7 days. */}
        {needsReminder(i, sends.get(i.id)?.lastReminderAt ?? null, now) ? <Badge tone="warning">needs reminder</Badge> : null}
      </span>
    ),
  },
  {
    key: 'sent',
    header: 'Last sent',
    desktopOnly: true,
    cellClassName: 'text-muted',
    cell: (i) => {
      const s = sends.get(i.id);
      return s?.lastAt ? `${s.lastKind === 'reminder' ? 'reminded' : 'sent'} ${clock.date(s.lastAt)}` : '—';
    },
  },
  {
    key: 'pdf',
    header: '',
    align: 'right',
    desktopOnly: true,
    cell: (i) => (
      <a href={`/api/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand hover:underline">
        Open PDF
      </a>
    ),
  },
  {
    key: 'total',
    header: 'Total',
    align: 'right',
    cellClassName: 'tabular font-medium',
    cell: (i) => money(i.total_minor, i.currency),
    sortKey: 'total',
  },
  {
    key: 'paid',
    header: 'Paid',
    align: 'right',
    cellClassName: 'tabular text-muted',
    cell: (i) => money(i.paid_minor, i.currency),
    sortKey: 'paid',
  },
  {
    key: 'issued',
    header: 'Issued',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (i) => (i.issued_at ? clock.date(i.issued_at) : '—'),
    sortKey: 'issued',
  },
  {
    key: 'due',
    header: 'Due',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (i) => (i.due_at ? clock.date(i.due_at) : '—'),
    sortKey: 'due',
  },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  total: (a, b) => a.total_minor - b.total_minor,
  paid: (a, b) => a.paid_minor - b.paid_minor,
  issued: (a, b) => (a.issued_at ?? '').localeCompare(b.issued_at ?? ''),
  due: (a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''),
};

/**
 * Invoice list.
 *
 * Same two-layer gate as the leads page: the capability is re-checked because
 * hiding the nav entry is not access control, and RLS refuses the rows
 * independently of both.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; status?: string; q?: string; client?: string; project?: string; issuedFrom?: string }>;
}) {
  const context = await requireInternal('/invoices');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir, status, q, client: clientId, project: projectId, issuedFrom: issuedFromParam } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  // Bucket F: the Command Center's "Invoices issued in the last N days" tile
  // lands here with `?issuedFrom=YYYY-MM-DD`, so the list is exactly the
  // count the tile showed.
  const issuedFrom = /^\d{4}-\d{2}-\d{2}$/.test(issuedFromParam ?? '') ? issuedFromParam : undefined;
  const keep = [
    status ? `status=${status}` : '',
    issuedFrom ? `issuedFrom=${issuedFrom}` : '',
    q ? `q=${encodeURIComponent(q)}` : '',
    clientId ? `client=${encodeURIComponent(clientId)}` : '',
    projectId ? `project=${encodeURIComponent(projectId)}` : '',
  ].filter(Boolean);
  const currentQuery = [...keep, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const qs = (extra: string) => `/invoices?${[...keep, extra].filter(Boolean).join('&')}`;
  const canCreate = can(context.role, 'invoice.create');
  // SCR-051: client and project filters are applied by the reader at the
  // database; the milestone picker needs every invoice (to know which
  // milestones are already billed) and every milestone, unfiltered.
  const [allInvoices, pendingClaims, savedViews, clients, projects, milestones, everyInvoice, sendSummaries] = await Promise.all([
    listInvoicesFiltered({ clientId, projectId }),
    can(context.role, 'invoice.issue') ? listPendingPaymentClaims() : Promise.resolve([]),
    listSavedViews('/invoices'),
    listBillingClients(),
    listProjects(500),
    canCreate ? listBillableMilestones() : Promise.resolve([]),
    canCreate ? listInvoices(2000) : Promise.resolve([]),
    readInvoiceSendSummaries(),
  ]);
  const now = new Date();
  const reminderCount = allInvoices.filter((i) => needsReminder(i, sendSummaries.get(i.id)?.lastReminderAt ?? null, now)).length;
  const invoicedMilestones = new Set(everyInvoice.map((i) => i.milestone_id).filter((id): id is string => id !== null));
  const eligible = milestones
    .filter((m) => !invoicedMilestones.has(m.id))
    .filter((m) => milestoneInvoiceability({ status: m.status, amountMinor: m.amountMinor, paymentPercent: m.paymentPercent }).ok)
    .map((m) => ({ id: m.id, projectId: m.projectId, name: m.name, position: m.position, amountLabel: money(m.amountMinor, m.currency) }));
  const needle = (q ?? '').trim().toLowerCase();
  const unpaid = (i: Row) => i.status === 'issued' || i.status === 'partially_paid' || i.status === 'overdue';
  const rawInvoices = allInvoices.filter(
    (i) =>
      (!status || (status === 'unpaid' ? unpaid(i) : i.status === status)) &&
      (!needle || i.number.toLowerCase().includes(needle)) &&
      (!issuedFrom || (i.issued_at !== null && i.issued_at >= issuedFrom)),
  );
  const invoices = sortRows(rawInvoices, sortKey, direction, COMPARATORS);
  const countBy = (st: string) => allInvoices.filter((i) => i.status === st).length;
  const currency = allInvoices[0]?.currency ?? 'INR';
  const sum = (pred: (i: Row) => boolean) => allInvoices.filter((i) => i.currency === currency && pred(i)).reduce((n, i) => n + i.total_minor - (pred === unpaid ? i.paid_minor : 0), 0);
  const outstanding = allInvoices.filter((i) => i.currency === currency && unpaid(i)).reduce((n, i) => n + i.total_minor - i.paid_minor, 0);
  const overdueAmount = allInvoices.filter((i) => i.currency === currency && i.status === 'overdue').reduce((n, i) => n + i.total_minor - i.paid_minor, 0);
  const paidAmount = allInvoices.filter((i) => i.currency === currency && i.status === 'paid').reduce((n, i) => n + i.total_minor, 0);
  void sum;
  const { page, pageCount, rows: pageRows } = paginate(invoices, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Invoices"
        description={
          invoices.length === 0
            ? 'No invoices raised yet.'
            : `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}.`
        }
      />

      {allInvoices.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Invoices" value={String(allInvoices.length)} caption={`${countBy('draft')} draft · ${countBy('pending_approval')} awaiting approval`} tone="brand" icon={<IconInvoices size={16} />} href="/invoices" />
          <Stat label="Paid" value={String(countBy('paid'))} caption={money(paidAmount, currency)} tone="success" icon={<IconCheck size={16} />} href="/invoices?status=paid" />
          <Stat label="Unpaid" value={String(allInvoices.filter(unpaid).length)} caption={`${money(outstanding, currency)} outstanding`} tone={outstanding > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/invoices?status=unpaid" />
          <Stat label="Overdue" value={String(countBy('overdue'))} caption={money(overdueAmount, currency)} tone={countBy('overdue') > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} href="/invoices?status=overdue" />
          <Stat label="Void" value={String(countBy('void'))} caption="Cancelled bills" tone="neutral" icon={<IconInvoices size={16} />} href="/invoices?status=void" />
        </StatGrid>
      ) : null}

      <FilterBar clearHref="/invoices" filtered={Boolean(status || q || clientId || projectId || issuedFrom)}>
        <FilterChips
          options={[
            { key: 'all', label: `All (${allInvoices.length})`, href: q ? `/invoices?q=${encodeURIComponent(q)}` : '/invoices', active: !status },
            { key: 'unpaid', label: `Unpaid (${allInvoices.filter(unpaid).length})`, href: `/invoices?status=unpaid${q ? `&q=${encodeURIComponent(q)}` : ''}`, active: status === 'unpaid' },
            ...INVOICE_STATUSES.map((st) => ({ key: st, label: `${humanize(st)} (${countBy(st)})`, href: `/invoices?status=${st}${q ? `&q=${encodeURIComponent(q)}` : ''}`, active: status === st })),
          ]}
        />
        <form method="get" action="/invoices" className="flex flex-wrap items-center gap-2">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <input name="q" defaultValue={q ?? ''} placeholder="Invoice number…" aria-label="Search invoices" className={cx(inputClass, 'w-48')} />
          <select name="client" defaultValue={clientId ?? ''} aria-label="Client" className={cx(selectClass, 'w-44')}>
            <option value="">Every client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select name="project" defaultValue={projectId ?? ''} aria-label="Project" className={cx(selectClass, 'w-44')}>
            <option value="">Every project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Apply
          </button>
          {clientId || projectId ? (
            <Link href="/invoices" className={buttonClass('ghost', 'sm')}>
              Clear
            </Link>
          ) : null}
        </form>
      </FilterBar>

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

      <SavedViewsBar page="/invoices" currentQuery={currentQuery} views={savedViews} />

      {reminderCount > 0 ? (
        <Callout tone="warning" icon={<IconClock size={16} />}>
          {reminderCount} invoice{reminderCount === 1 ? ' is' : 's are'} past due with no reminder recorded in the last 7 days. Open each one, send the reminder yourself, and record it there.
        </Callout>
      ) : null}

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

      {invoices.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock, sendSummaries, now)}
            getKey={(i) => i.id}
            href={(i) => `/invoices/${i.id}`}
            // Bucket F: the shared per-row overflow menu.
            rowActions={(i) => [
              { key: 'open', label: 'Open invoice', href: `/invoices/${i.id}` },
              { key: 'pdf', label: 'Open PDF', href: `/api/invoices/${i.id}/pdf` },
              ...(i.project_id ? [{ key: 'project', label: 'Open project', href: `/projects/${i.project_id}` }] : []),
              { key: 'client', label: 'Open client', href: `/clients/${i.client_account_id}` },
            ]}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) => qs(`sort=${key}&dir=${nextDirection}`),
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => qs(`${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`)}
          />
        </>
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title="No invoices yet"
          description="Invoices raised against project milestones will appear here."
          action={<Link href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</Link>}
        />
      )}
    </div>
  );
}
