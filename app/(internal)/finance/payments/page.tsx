import type { Metadata } from 'next';

import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPaymentAccounts, listPayments, listPendingPaymentClaims } from '@/modules/finance/queries';
import { listPaymentSubmissions } from '@/modules/finance/overview-queries';
import { listReconciliationItems, listReconciliations, readMatchProposal } from '@/modules/finance/reconciliation-queries';
import { listBankStatementLines } from '@/modules/finance/bank-import-queries';
import { BANK_LINE_STATUS_LABEL } from '@/modules/finance/bank-import-schema';
import { proposeMatches, type MatchCandidate } from '@/modules/finance/bank-csv';

import { ConfirmBankLineMatchForm, IgnoreBankLineForm, ImportBankStatementForm } from './bank-import-panel';
import { ClaimsDrawerList } from './claims-drawer';
import {
  AddReconciliationItemForm,
  CloseReconciliationForm,
  OpenReconciliationForm,
  ResolveReconciliationItemForm,
} from './reconciliation-panel';
import { SavedViewsBar } from '../../saved-views-bar';
import {
  Badge,
  Callout,
  Card,
  CardHeader,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconAlert,
  IconInvoices,
  paginate,
  Pagination,
  PageHeader,
  StatGrid,
  Stat,
  statusTone,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
} from '@/ui';

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
    sortKey: 'amount',
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
    sortKey: 'captured',
  },
  {
    key: 'verified',
    header: 'Verified',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => (p.verified_at ? clock.dateTime(p.verified_at) : '—'),
    sortKey: 'verified',
  },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  amount: (a, b) => a.amount_minor - b.amount_minor,
  captured: (a, b) => (a.captured_at ?? '').localeCompare(b.captured_at ?? ''),
  verified: (a, b) => (a.verified_at ?? '').localeCompare(b.verified_at ?? ''),
};

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
  searchParams: Promise<{ status?: string; page?: string; sort?: string; dir?: string; recon?: string }>;
}) {
  const context = await requireInternal('/finance/payments');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir, recon: reconParam } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = [status ? `status=${status}` : '', sortKey ? `sort=${sortKey}&dir=${direction}` : '']
    .filter(Boolean)
    .join('&');
  const mayReconcile = can(context.role, 'invoice.issue');
  const [allPayments, savedViews, pendingClaims, claims, reconciliations, accounts] = await Promise.all([
    listPayments(),
    listSavedViews('/finance/payments'),
    mayReconcile ? listPendingPaymentClaims() : Promise.resolve([]),
    listPaymentSubmissions('all', 300),
    listReconciliations(),
    listPaymentAccounts(),
  ]);
  // Reconciliation — Doc 15 §15/§29, gap row 053. The tables existed with no
  // door; reconciliation-service.ts is the door now. The selected period is
  // `?recon=`, else the first open one.
  const selectedRecon = reconciliations.find((r) => r.id === reconParam) ?? reconciliations.find((r) => r.status === 'open') ?? null;
  const reconItems = selectedRecon ? await listReconciliationItems(selectedRecon.id) : [];
  // §29's auto-match: proposed for each unmatched line, never applied.
  const proposals = new Map<string, string | null>();
  if (selectedRecon?.status === 'open') {
    await Promise.all(
      reconItems
        .filter((i) => i.finding !== 'matched' && !i.paymentId)
        .map(async (i) => {
          const p = await readMatchProposal(i.id);
          proposals.set(i.id, p.outcome === 'matched' ? p.paymentId : null);
        }),
    );
  }
  const paymentOptions = allPayments
    .filter((p) => p.status === 'captured')
    .map((p) => ({ id: p.id, label: `${money(p.amount_minor, p.currency)} · ${p.invoiceNumber} · ${p.provider_payment_id}` }));
  // The bank CSV — owner decision 2026-09-29. Uploaded lines of the selected
  // period, and a proposal per pending line against the recorded payments
  // (what can be confirmed) and the pending claims (what a person can go and
  // verify first). Proposed here, written only by the confirm door.
  const bankLines = selectedRecon ? await listBankStatementLines(selectedRecon.id) : [];
  const matchCandidates: MatchCandidate[] = [
    ...allPayments
      .filter((p) => p.status === 'captured')
      .map((p): MatchCandidate => ({
        kind: 'payment',
        id: p.id,
        amountMinor: p.amount_minor,
        reference: p.provider_payment_id,
        label: `${money(p.amount_minor, p.currency)} · ${p.invoiceNumber} · ${p.clientName}`,
        invoiceNumber: p.invoiceNumber,
      })),
    ...claims
      .filter((c) => c.status === 'pending_verification' || c.status === 'mismatch')
      .map((c): MatchCandidate => ({
        kind: 'claim',
        id: c.id,
        amountMinor: c.amountMinor,
        reference: c.reference,
        label: `${money(c.amountMinor, c.currency)} · ${c.invoiceNumber} · claim by ${c.payerName ?? c.clientName ?? 'client'}`,
        invoiceNumber: c.invoiceNumber,
      })),
  ];
  const bankProposals = new Map(
    proposeMatches(
      bankLines.filter((l) => l.status === 'pending').map((l) => ({ id: l.id, amountMinor: l.amountMinor, reference: l.reference, description: l.description })),
      matchCandidates,
    ).map((p) => [p.lineId, p]),
  );
  const pendingBankLines = bankLines.filter((l) => l.status === 'pending').length;
  // SCR-053's four KPIs count the claims table and say so: "submitted" is
  // what clients said, "verified" / "rejected" the answers, "pending" what
  // has none yet. The ledger rows below are money that moved.
  const pendingCount = claims.filter((c) => c.status === 'pending_verification' || c.status === 'mismatch').length;
  const verifiedCount = claims.filter((c) => c.status === 'verified').length;
  const rejectedCount = claims.filter((c) => c.status === 'rejected').length;
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
  const filtered = status ? allPayments.filter((p) => p.status === status) : allPayments;
  const payments = sortRows(filtered, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(payments, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

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

      {pendingClaims.length > 0 ? (
        <Callout tone="warning" icon={<IconAlert size={16} />}>
          <span className="flex flex-wrap items-center gap-2">
            {pendingClaims.length} payment claim{pendingClaims.length === 1 ? '' : 's'} awaiting a decision —
            not yet in the register below.
            <Link href="/invoices/verify" className="font-medium underline underline-offset-2">
              Open the verification queue
            </Link>
          </span>
        </Callout>
      ) : null}

      <StatGrid>
        <Stat label="Submitted" value={String(claims.length)} caption="Claims clients made, all time" href="#claims" />
        <Stat label="Pending" value={String(pendingCount)} caption="Awaiting a decision" tone={pendingCount > 0 ? 'warning' : 'neutral'} href="/invoices/verify" />
        <Stat label="Verified" value={String(verifiedCount)} caption="Claims somebody confirmed" tone={verifiedCount > 0 ? 'success' : 'neutral'} />
        <Stat label="Rejected" value={String(rejectedCount)} caption="Refused, with a reason" tone={rejectedCount > 0 ? 'danger' : 'neutral'} />
      </StatGrid>

      {byCurrency.size > 0 ? (
        <StatGrid>
          {[...byCurrency.entries()].map(([currency, total]) => (
            <Stat
              key={currency}
              label={`Captured (${currency})`}
              value={money(total, currency)}
              caption="Ledger payments the provider confirmed"
              tone="success"
              icon={<IconInvoices size={16} />}
            />
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

      <SavedViewsBar page="/finance/payments" currentQuery={currentQuery} views={savedViews} />

      {payments.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock)}
            getKey={(p) => p.id}
            href={(p) => `/invoices/${p.invoiceId}`}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) =>
                `/finance/payments?${status ? `status=${status}&` : ''}sort=${key}&dir=${nextDirection}`,
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) =>
              `/finance/payments?${status ? `status=${status}&` : ''}${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`
            }
          />
        </>
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title={status ? 'No matching payments' : 'No payments yet'}
          description={
            status ? `No payments are currently "${humanize(status)}".` : 'A payment appears here once the provider confirms it.'
          }
        />
      )}

      <Card id="reconciliation">
        <CardHeader
          title="Reconciliation"
          description="Recorded payments checked against the bank statement, period by period (Doc 15 §15). A reading, never a correction: nothing here alters a payment."
          actions={
            reconciliations.length > 0 ? (
              <FilterChips
                options={reconciliations.slice(0, 8).map((r) => ({
                  key: r.id,
                  label: `${r.periodStart} → ${r.periodEnd}${r.status === 'closed' ? ' (closed)' : ''}`,
                  href: `/finance/payments?recon=${r.id}#reconciliation`,
                  active: selectedRecon?.id === r.id,
                }))}
              />
            ) : null
          }
        />
        <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
          {selectedRecon ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <Badge tone={selectedRecon.status === 'open' ? 'brand' : 'neutral'} dot>{selectedRecon.status}</Badge>
                <span className="font-medium">{selectedRecon.source}</span>
                <span className="text-muted">
                  · {selectedRecon.itemCount} line{selectedRecon.itemCount === 1 ? '' : 's'}
                  {selectedRecon.unresolvedCount > 0 ? `, ${selectedRecon.unresolvedCount} unexplained` : ''}
                  · opened {clock.date(selectedRecon.openedAt)}
                  {selectedRecon.closedAt ? ` · closed ${clock.date(selectedRecon.closedAt)}` : ''}
                </span>
              </div>

              {reconItems.length > 0 ? (
                <DataTable
                  rows={reconItems}
                  dense
                  columns={[
                    { key: 'date', header: 'Date', primary: true, cell: (i) => clock.date(i.statementDate) },
                    { key: 'line', header: 'Statement line', cellClassName: 'font-mono text-xs', cell: (i) => i.statementLine },
                    { key: 'amount', header: 'Amount', align: 'right', cellClassName: 'tabular font-medium', cell: (i) => money(i.amountMinor, 'INR') },
                    { key: 'finding', header: 'Finding', badge: true, cell: (i) => <Badge tone={i.finding === 'matched' ? 'success' : i.reason ? 'neutral' : 'warning'}>{humanize(i.finding)}</Badge> },
                    {
                      key: 'work',
                      header: selectedRecon.status === 'open' && mayReconcile ? 'Work it' : 'Reason',
                      cell: (i) =>
                        selectedRecon.status === 'open' && mayReconcile ? (
                          <ResolveReconciliationItemForm
                            itemId={i.id}
                            finding={i.finding}
                            paymentId={i.paymentId}
                            reason={i.reason}
                            proposedPaymentId={proposals.get(i.id) ?? null}
                            payments={paymentOptions}
                          />
                        ) : (
                          <span className="text-muted">{i.reason ?? '—'}</span>
                        ),
                    },
                  ]}
                  getKey={(i) => i.id}
                />
              ) : (
                <p className="text-[13px] text-muted">No statement lines yet. Upload the bank CSV below, or paste a line by hand.</p>
              )}

              {/*
                The bank statement, uploaded — owner decision 2026-09-29. Each
                line as the bank printed it, the match the page proposes, and
                the two doors: confirm (writes the reconciliation item above)
                or set aside with a reason.
              */}
              <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-[13px] font-semibold tracking-tight">
                    Bank statement <span className="text-muted">({bankLines.length} line{bankLines.length === 1 ? '' : 's'}{pendingBankLines > 0 ? `, ${pendingBankLines} pending` : ''})</span>
                  </h3>
                  <span className="text-xs text-muted">Matches are proposed by amount and reference; nothing is written until you confirm.</span>
                </div>
                {bankLines.length > 0 ? (
                  <DataTable
                    rows={bankLines}
                    dense
                    columns={[
                      { key: 'date', header: 'Date', primary: true, cell: (l) => clock.date(l.statementDate) },
                      { key: 'desc', header: 'Description', cellClassName: 'font-mono text-xs', cell: (l) => l.description },
                      { key: 'ref', header: 'Reference', cellClassName: 'font-mono text-xs text-muted', cell: (l) => l.reference ?? '—' },
                      { key: 'amount', header: 'Amount', align: 'right', cellClassName: 'tabular font-medium', cell: (l) => money(l.amountMinor, 'INR') },
                      {
                        key: 'status',
                        header: 'Status',
                        badge: true,
                        cell: (l) => (
                          <Badge tone={l.status === 'confirmed' ? 'success' : l.status === 'ignored' ? 'neutral' : 'warning'}>
                            {BANK_LINE_STATUS_LABEL[l.status] ?? l.status}
                          </Badge>
                        ),
                      },
                      {
                        key: 'proposal',
                        header: 'Proposed match',
                        cell: (l) => {
                          if (l.status === 'ignored') return <span className="text-muted">{l.ignoredReason}</span>;
                          if (l.status === 'confirmed') return <span className="text-muted">written as a reconciliation line</span>;
                          const p = bankProposals.get(l.id);
                          if (!p || !p.candidate) {
                            return (
                              <span className="text-muted">
                                {p?.reason === 'ambiguous' ? `${p.sameAmount.length} records have this amount — pick one` : 'no record with this amount or reference'}
                              </span>
                            );
                          }
                          return (
                            <span>
                              {p.candidate.label}
                              <span className="text-muted"> · {p.candidate.kind === 'claim' ? 'a pending claim: verify it first, then match the payment' : p.reason === 'reference_and_amount' ? 'reference and amount agree' : p.reason === 'reference' ? 'reference agrees, amount differs' : 'only record with this amount'}</span>
                            </span>
                          );
                        },
                      },
                      {
                        key: 'work',
                        header: 'Work it',
                        cell: (l) =>
                          l.status === 'pending' && selectedRecon.status === 'open' && mayReconcile ? (
                            <div className="flex flex-col gap-2">
                              <ConfirmBankLineMatchForm
                                lineId={l.id}
                                proposedPaymentId={bankProposals.get(l.id)?.candidate?.kind === 'payment' ? bankProposals.get(l.id)!.candidate!.id : null}
                                payments={paymentOptions}
                              />
                              <IgnoreBankLineForm lineId={l.id} />
                            </div>
                          ) : (
                            <span className="text-muted">—</span>
                          ),
                      },
                    ]}
                    getKey={(l) => l.id}
                  />
                ) : (
                  <p className="text-[13px] text-muted">No statement uploaded for this period yet.</p>
                )}
                {selectedRecon.status === 'open' && mayReconcile ? <ImportBankStatementForm reconciliationId={selectedRecon.id} /> : null}
              </div>

              {selectedRecon.status === 'open' && mayReconcile ? (
                <>
                  <AddReconciliationItemForm reconciliationId={selectedRecon.id} payments={paymentOptions} />
                  <CloseReconciliationForm reconciliationId={selectedRecon.id} unresolved={selectedRecon.unresolvedCount} />
                </>
              ) : null}
            </>
          ) : (
            <p className="text-[13px] text-muted">No reconciliation has been opened yet.</p>
          )}

          {mayReconcile && !reconciliations.some((r) => r.status === 'open' && r.accountId === null) ? (
            <OpenReconciliationForm accounts={accounts.filter((a) => a.status === 'active').map((a) => ({ id: a.id, label: a.label }))} />
          ) : mayReconcile ? (
            <p className="text-xs text-muted">Close the open period before opening another for the same account.</p>
          ) : null}
        </div>
      </Card>

      <Card id="claims">
        <CardHeader
          title="Payment claims"
          description="What clients said they paid, newest first, with the proof and the decision. A claim is not money — the register above is."
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
