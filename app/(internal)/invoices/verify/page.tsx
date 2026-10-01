import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { listPendingPaymentClaims } from '@/modules/finance/queries';
import { claimProofHref, proofIsImage } from '@/modules/finance/attachment-links';
import { listPaymentSubmissions } from '@/modules/finance/overview-queries';
import { listRecentBankLines } from '@/modules/finance/bank-import-queries';
import { crossCheckClaim, crossCheckSentence, filterQueue } from '@/modules/finance/claim-queue';
import { normaliseSearch } from '@/lib/db/search';
import { Badge, buttonClass, Card, CardHeader, DomainSearch, EmptyState, FilterBar, FilterChips, humanize, IconInvoices, PageHeader, PermissionDenied, Stat, StatGrid, StatusBadge } from '@/ui';

import { ClaimDecision } from './claim-decision';

export const metadata: Metadata = { title: 'Payment verification' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

function when(clock: AgencyClock, value: string): string {
  return clock.date(value);
}


/**
 * The proof a claim carries, previewed when the URL says it is an image and
 * linked otherwise. A URL with no image extension may still be one, and an
 * image extension may lie — but rendering a PDF as `<img>` shows a broken
 * box where a link would have worked, so the rule errs toward the link.
 */
function Proof({ url, fileName }: { url: string | null; fileName?: string | null }) {
  if (!url) return <span className="text-muted">none attached</span>;
  return (
    <span className="flex flex-col gap-2">
      <a href={url} target="_blank" rel="noreferrer" className="w-fit underline-offset-2 hover:underline">
        {fileName ? `Open uploaded proof (${fileName})` : 'Open proof'}
      </a>
      {proofIsImage(url, fileName) ? (
        <img src={url} alt="Payment proof" className="max-h-56 w-fit max-w-full rounded-lg border border-line object-contain" />
      ) : null}
    </span>
  );
}

/**
 * Payment verification — SCR-054, the financial gate on its own screen.
 *
 * The service, the door and the per-project panel (claims-panel.tsx) already
 * existed; this is the org-wide queue Doc 15 §12 describes, so an owner does
 * not have to open every project to find the claims nobody has answered.
 * Same VerifyClaimForm the project page uses — one implementation, two entry
 * points. No verified payment moves an invoice by itself: this records that
 * somebody checked a claim, recordManualPayment is the separate act that
 * writes the ledger.
 *
 * Below the queue, the decisions already made — who verified or rejected
 * what, and on what evidence — so the queue is not the only record of the
 * gate having been kept.
 */
export default async function PaymentVerificationPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const context = await requireInternal('/invoices/verify');
  const clock = await agencyClock();
  if (!can(context, 'invoice.issue')) return <PermissionDenied />;

  const { q: qRaw, status: statusParam } = await searchParams;
  const q = normaliseSearch(qRaw);
  const QUEUE_STATUSES = ['pending_verification', 'mismatch', 'evidence_requested', 'verified', 'rejected'];
  const status = QUEUE_STATUSES.includes(statusParam ?? '') ? statusParam : undefined;
  const [allClaims, allSettled, bankLines] = await Promise.all([listPendingPaymentClaims(), listPaymentSubmissions('settled', 100), listRecentBankLines()]);
  // SCR-054 search/filtering: over the queue AND the decision history, by what a reviewer types.
  const asQueue = <T extends { id: string; status: string }>(rows: T[], shape: (r: T) => { amountMinor: number; reference: string | null; payerName: string | null; invoiceNumber: string; clientName: string | null; projectName: string | null }) =>
    filterQueue(rows.map((r) => ({ ...r, ...shape(r) })), { q, status });
  const claims = asQueue(allClaims, (c) => ({ amountMinor: c.amount_minor, reference: c.reference, payerName: c.payer_name, invoiceNumber: c.invoiceNumber, clientName: c.clientName, projectName: c.projectName }));
  const settled = asQueue(allSettled, (c) => ({ amountMinor: c.amountMinor, reference: c.reference, payerName: c.payerName, invoiceNumber: c.invoiceNumber, clientName: c.clientName, projectName: null }));
  const filtering = Boolean(q || status);

  const mismatches = allClaims.filter((c) => c.status === 'mismatch').length;
  const evidenceAsked = allClaims.filter((c) => c.status === 'evidence_requested').length;
  const verifiedCount = allSettled.filter((c) => c.status === 'verified').length;
  const rejectedCount = allSettled.filter((c) => c.status === 'rejected').length;
  const oldest = allClaims[0];
  const oldestAgeDays = oldest ? Math.floor((Date.now() - new Date(oldest.submitted_at).getTime()) / 86_400_000) : null;

  return (
    <div className="flex flex-col gap-5">
      {/* E4: a claim arriving or answered in another session shows here without a reload (test matrix §5 scenario 3). */}
      <PageHeader
        title="Payment verification"
        description={
          allClaims.length === 0
            ? 'Nothing awaiting a decision.'
            : `${allClaims.length} claim${allClaims.length === 1 ? '' : 's'} awaiting a decision, oldest first.`
        }
        actions={<LiveRefresh topics={['finance']} />}
      />

      <StatGrid>
        <Stat
          label="Pending"
          value={allClaims.length}
          tone={allClaims.length > 0 ? 'warning' : 'neutral'}
          caption={mismatches + evidenceAsked > 0 ? `${mismatches} mismatch · ${evidenceAsked} sent back for evidence` : 'claims nobody has answered'}
        />
        <Stat
          label="Oldest waiting"
          value={oldestAgeDays === null ? '—' : `${oldestAgeDays}d`}
          caption={oldest ? `claimed ${when(clock, oldest.submitted_at)}` : 'the queue is empty'}
          tone={oldestAgeDays !== null && oldestAgeDays > 3 ? 'danger' : 'neutral'}
        />
        <Stat label="Verified" value={verifiedCount} tone={verifiedCount > 0 ? 'success' : 'neutral'} caption="of the last 100 settled" />
        <Stat label="Rejected" value={rejectedCount} tone={rejectedCount > 0 ? 'danger' : 'neutral'} caption="of the last 100 settled" />
      </StatGrid>

      <FilterBar clearHref="/invoices/verify" filtered={filtering}>
        <DomainSearch action="/invoices/verify" value={q} placeholder="Client, invoice, reference, amount…" label="Search claims" preserve={{ status }} />
        <FilterChips
          options={[
            { key: 'all', label: 'All', href: q ? `/invoices/verify?q=${encodeURIComponent(q)}` : '/invoices/verify', active: !status },
            ...QUEUE_STATUSES.map((st) => ({ key: st, label: humanize(st), href: `/invoices/verify?status=${st}${q ? `&q=${encodeURIComponent(q)}` : ''}`, active: status === st })),
          ]}
        />
      </FilterBar>

      {claims.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {claims.map((c) => (
            <li key={c.id}>
              <Card className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-baseline gap-2 text-sm font-semibold">
                      {money(c.amount_minor, c.currency)}
                      <StatusBadge status={c.status} />
                    </span>
                    <span className="text-[13px] text-muted">
                      {c.clientName ?? 'Unknown client'}
                      {c.projectId ? (
                        <>
                          {' · '}
                          <Link href={`/projects/${c.projectId}`} className="underline-offset-2 hover:underline">
                            {c.projectName ?? 'project'}
                          </Link>
                        </>
                      ) : null}
                      {' · '}
                      <Link href={`/invoices/${c.invoice_id}`} className="font-mono underline-offset-2 hover:underline">
                        {c.invoiceNumber}
                      </Link>
                    </span>
                  </span>
                  <span className="text-right text-[13px] text-muted">
                    <span className="block">claimed {when(clock, c.submitted_at)}</span>
                    {c.paid_at ? <span className="block">said paid {when(clock, c.paid_at)}</span> : null}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
                  <div>
                    <dt className="text-muted">Method</dt>
                    <dd>{c.method.replace('_', ' ')}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Reference</dt>
                    <dd className="font-mono">{c.reference ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Payer</dt>
                    <dd>{c.payer_name ?? '—'}</dd>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <dt className="text-muted">Evidence</dt>
                    <dd>
                      <Proof url={claimProofHref({ id: c.id, proofUrl: c.proof_url, proofFileName: c.proof_file_name })} fileName={c.proof_file_name} />
                    </dd>
                  </div>
                </dl>
                {c.mismatch_note ? (
                  <p className="mt-2 text-[13px] text-warning">Mismatch noted: {c.mismatch_note}</p>
                ) : null}
                {c.evidence_request_note ? (
                  <p className="mt-2 text-[13px] text-warning">More evidence asked for: {c.evidence_request_note}</p>
                ) : null}
                <div className="mt-3 grid gap-2 rounded-lg border border-line bg-canvas p-3 text-[13px] sm:grid-cols-2">
                  <p>
                    <span className="text-muted">Invoice context: </span>
                    <span className="tabular">{money(c.invoiceTotalMinor, c.invoiceCurrency)}</span> total ·{' '}
                    <span className="tabular">{money(c.invoiceVerifiedMinor, c.invoiceCurrency)}</span> verified ·{' '}
                    <span className="tabular font-medium">{money(Math.max(0, c.invoiceTotalMinor - c.invoiceVerifiedMinor), c.invoiceCurrency)}</span> still owed
                    <Badge tone="neutral" className="ml-2">{humanize(c.invoiceStatus)}</Badge>
                  </p>
                  <p>
                    <span className="text-muted">Bank cross-check: </span>
                    {crossCheckSentence(crossCheckClaim({ reference: c.reference, amountMinor: c.amount_minor }, bankLines.filter((l) => l.status !== 'ignored')))}
                  </p>
                </div>
                <ClaimDecision claimId={c.id} invoiceId={c.invoice_id} projectId={c.projectId} />
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title={filtering ? 'No claim matches' : 'Nothing awaiting verification'}
          description={filtering ? 'Nothing in the queue matches these filters.' : 'A claim a client says they paid appears here until somebody confirms, rejects, or flags it as a mismatch.'}
          action={
            filtering ? (
              <Link href="/invoices/verify" className={buttonClass('secondary', 'sm')}>Clear the filters</Link>
            ) : (
              <Link href="/finance/payments" className={buttonClass('secondary', 'sm')}>Open payments</Link>
            )
          }
        />
      )}

      <Card>
        <CardHeader
          title="Decision history"
          description="Claims already answered, newest decision first — who decided, and on what."
        />
        {settled.length > 0 ? (
          <ul className="divide-y divide-line">
            {settled.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 px-4 py-3 text-[13px] sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium tabular">{money(c.amountMinor, c.currency)}</span>
                    <StatusBadge status={c.status} />
                    <Link href={`/invoices/${c.invoiceId}`} className="font-mono text-muted underline-offset-2 hover:underline">
                      {c.invoiceNumber}
                    </Link>
                    <span className="text-muted">{c.clientName ?? 'Unknown client'}</span>
                  </span>
                  <span className="text-muted">
                    {c.status === 'verified' ? 'verified' : 'rejected'} by {c.verifiedByName ?? 'unnamed'}
                    {c.verifiedAt ? ` · ${clock.dateTime(c.verifiedAt)}` : ''}
                  </span>
                </div>
                {c.status === 'verified' && c.verificationEvidence ? (
                  <p className="text-muted">Checked: {c.verificationEvidence}</p>
                ) : null}
                {c.status === 'rejected' && c.rejectedReason ? <p className="text-muted">Reason: {c.rejectedReason}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No claim has been decided yet.</p>
        )}
      </Card>
    </div>
  );
}
