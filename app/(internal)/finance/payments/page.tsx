import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPayments } from '@/modules/finance/queries';
import { listPaymentSubmissions } from '@/modules/finance/overview-queries';
import {
  Badge,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconInvoices,
  PageHeader,
  StatGrid,
  Stat,
  statusTone,
  type Column,
} from '@/ui';

import { ClaimsDrawerList } from './claims-drawer';

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
 * actual captured/verified record.
 *
 * The four KPIs at the top count both tables, and say which: "submitted"
 * is claims (what a client said), "verified" and "rejected" are the
 * answers those claims got, "pending" is what still has none. The ledger
 * rows below are money that moved. No reconciliation control: the
 * `finance.reconciliations` tables exist with no service over them, and a
 * button onto a table with no door would be a fake.
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
  const [allPayments, claims] = await Promise.all([listPayments(), listPaymentSubmissions('all', 300)]);
  const payments = status ? allPayments.filter((p) => p.status === status) : allPayments;

  const byCurrency = new Map<string, number>();
  for (const p of allPayments) {
    if (p.status !== 'captured') continue;
    byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + p.amount_minor);
  }

  const pending = claims.filter((c) => c.status === 'pending_verification' || c.status === 'mismatch').length;
  const verified = claims.filter((c) => c.status === 'verified').length;
  const rejected = claims.filter((c) => c.status === 'rejected').length;

  const claimViews = claims.map((c) => ({
    id: c.id,
    invoiceId: c.invoiceId,
    invoiceNumber: c.invoiceNumber,
    clientName: c.clientName,
    amountLabel: money(c.amountMinor, c.currency),
    method: c.method,
    reference: c.reference,
    payerName: c.payerName,
    paidAtLabel: c.paidAt ? clock.date(c.paidAt) : null,
    proofUrl: c.proofUrl,
    status: c.status,
    submittedAtLabel: clock.dateTime(c.submittedAt),
    verifiedAtLabel: c.verifiedAt ? clock.dateTime(c.verifiedAt) : null,
    verifiedByName: c.verifiedByName,
    verificationEvidence: c.verificationEvidence,
    rejectedReason: c.rejectedReason,
    mismatchNote: c.mismatchNote,
    paymentId: c.paymentId,
  }));

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

      <StatGrid>
        <Stat label="Submitted" value={claims.length} caption="claims a client made, all time" href="#claims" />
        <Stat label="Pending" value={pending} caption="awaiting a decision" tone={pending > 0 ? 'warning' : 'neutral'} href="/invoices/verify" />
        <Stat label="Verified" value={verified} caption="claims somebody confirmed" tone={verified > 0 ? 'success' : 'neutral'} />
        <Stat label="Rejected" value={rejected} caption="claims refused, with a reason" tone={rejected > 0 ? 'danger' : 'neutral'} />
      </StatGrid>

      {byCurrency.size > 0 ? (
        <StatGrid>
          {[...byCurrency.entries()].map(([currency, total]) => (
            <Stat key={currency} label={`Captured (${currency})`} value={money(total, currency)} tone="success" caption="ledger payments the provider confirmed" />
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

      <Card id="claims">
        <CardHeader
          title="Payment claims"
          description="What clients said they paid, newest first, with the proof and the decision. A claim is not money — the ledger above is."
        />
        {claimViews.length > 0 ? (
          <ClaimsDrawerList claims={claimViews} />
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No claim has been recorded yet.</p>
        )}
      </Card>
    </div>
  );
}
