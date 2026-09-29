import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPendingPaymentClaims } from '@/modules/finance/queries';
import { listPaymentSubmissions } from '@/modules/finance/overview-queries';
import { Card, CardHeader, EmptyState, IconInvoices, PageHeader, Stat, StatGrid, StatusBadge } from '@/ui';

import { VerifyClaimForm } from '../../projects/[projectId]/claims-panel';

export const metadata: Metadata = { title: 'Payment verification' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

function when(clock: AgencyClock, value: string): string {
  return clock.date(value);
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;

/**
 * The proof a claim carries, previewed when the URL says it is an image and
 * linked otherwise. A URL with no image extension may still be one, and an
 * image extension may lie — but rendering a PDF as `<img>` shows a broken
 * box where a link would have worked, so the rule errs toward the link.
 */
function Proof({ url }: { url: string | null }) {
  if (!url) return <span className="text-muted">none attached</span>;
  return (
    <span className="flex flex-col gap-2">
      <a href={url} target="_blank" rel="noreferrer" className="w-fit underline-offset-2 hover:underline">
        Open proof
      </a>
      {IMAGE_EXT.test(url) ? (
        // eslint-disable-next-line @next/next/no-img-element -- an external proof URL of unknown dimensions; next/image needs a configured host
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
export default async function PaymentVerificationPage() {
  const context = await requireInternal('/invoices/verify');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.issue')) redirect('/invoices');

  const [claims, settled] = await Promise.all([listPendingPaymentClaims(), listPaymentSubmissions('settled', 100)]);

  const mismatches = claims.filter((c) => c.status === 'mismatch').length;
  const verifiedCount = settled.filter((c) => c.status === 'verified').length;
  const rejectedCount = settled.filter((c) => c.status === 'rejected').length;
  const oldest = claims[0];
  const oldestAgeDays = oldest ? Math.floor((Date.now() - new Date(oldest.submitted_at).getTime()) / 86_400_000) : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Payment verification"
        description={
          claims.length === 0
            ? 'Nothing awaiting a decision.'
            : `${claims.length} claim${claims.length === 1 ? '' : 's'} awaiting a decision, oldest first.`
        }
      />

      <StatGrid>
        <Stat
          label="Pending"
          value={claims.length}
          tone={claims.length > 0 ? 'warning' : 'neutral'}
          caption={mismatches > 0 ? `${mismatches} flagged as a mismatch` : 'claims nobody has answered'}
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
                      <Proof url={c.proof_url} />
                    </dd>
                  </div>
                </dl>
                {c.mismatch_note ? (
                  <p className="mt-2 text-[13px] text-warning">Mismatch noted: {c.mismatch_note}</p>
                ) : null}
                <VerifyClaimForm projectId={c.projectId} claim={c} />
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title="Nothing awaiting verification"
          description="A claim a client says they paid appears here until somebody confirms, rejects, or flags it as a mismatch."
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
