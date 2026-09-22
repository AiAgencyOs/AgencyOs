import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPayments } from '@/modules/finance/queries';
import { Badge, DataTable, EmptyState, FilterBar, FilterChips, humanize, IconInvoices, PageHeader, StatGrid, Stat, statusTone, type Column } from '@/ui';

export const metadata: Metadata = { title: 'Payments' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

const STATUS_FILTERS = ['captured', 'authorized', 'created', 'failed', 'refunded'];

type Row = Awaited<ReturnType<typeof listPayments>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  {
    key: 'invoice',
    header: 'Invoice',
    primary: true,
    cell: (p) => (
      <>
        <span className="block font-mono text-xs font-medium text-foreground">{p.invoiceNumber}</span>
        <span className="block text-[13px] text-muted">{p.clientName}</span>
      </>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    badge: true,
    cell: (p) => <Badge tone={statusTone(p.status)}>{humanize(p.status)}</Badge>,
  },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    cellClassName: 'tabular font-medium',
    cell: (p) => money(p.amount_minor, p.currency),
  },
  {
    key: 'provider',
    header: 'Provider',
    cellClassName: 'text-muted',
    cell: (p) => `${humanize(p.provider)} · ${p.provider_payment_id}`,
  },
  {
    key: 'captured',
    header: 'Captured',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => (p.captured_at ? clock.dateTime(p.captured_at) : '—'),
  },
  {
    key: 'verified',
    header: 'Verified',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => (p.verified_at ? clock.dateTime(p.verified_at) : '—'),
  },
];

/**
 * Every recorded payment, across every invoice — SCR-053. Distinct from
 * `/invoices/verify` (SCR-054): that page queues unverified claims
 * (`finance.payment_submissions`); this reads `finance.payments`, the
 * actual captured/verified record. Confirmed genuinely missing — the only
 * existing reader (`listInvoicePayments`) was scoped to one invoice.
 *
 * Same gate as the rest of Finance: `invoice.read`.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const context = await requireInternal('/finance/payments');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) redirect('/finance');

  const { status } = await searchParams;
  const allPayments = await listPayments();
  const payments = status ? allPayments.filter((p) => p.status === status) : allPayments;

  const byCurrency = new Map<string, number>();
  for (const p of allPayments) {
    if (p.status !== 'captured') continue;
    byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + p.amount_minor);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Payments"
        description={
          allPayments.length === 0
            ? 'No payments recorded yet.'
            : `${allPayments.length} payment${allPayments.length === 1 ? '' : 's'} recorded.`
        }
      />

      {byCurrency.size > 0 ? (
        <StatGrid>
          {[...byCurrency.entries()].map(([currency, total]) => (
            <Stat key={currency} label={`Captured (${currency})`} value={money(total, currency)} tone="success" />
          ))}
        </StatGrid>
      ) : null}

      <FilterBar>
        <FilterChips
          options={[
            { key: 'all', label: 'All', href: '/finance/payments', active: !status },
            ...STATUS_FILTERS.map((s) => ({
              key: s,
              label: humanize(s),
              href: `/finance/payments?status=${s}`,
              active: status === s,
            })),
          ]}
        />
      </FilterBar>

      {payments.length > 0 ? (
        <DataTable rows={payments} columns={columnsFor(clock)} getKey={(p) => p.id} href={(p) => `/invoices/${p.invoiceId}`} />
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title={status ? 'No matching payments' : 'No payments yet'}
          description={
            status ? `No payments are currently "${humanize(status)}".` : 'A payment appears here once the provider confirms it.'
          }
        />
      )}
    </div>
  );
}
