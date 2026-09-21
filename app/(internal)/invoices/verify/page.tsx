import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPendingPaymentClaims } from '@/modules/finance/queries';
import { Card, EmptyState, IconInvoices, PageHeader, StatusBadge } from '@/ui';

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
 */
export default async function PaymentVerificationPage() {
  const context = await requireInternal('/invoices/verify');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.issue')) redirect('/invoices');

  const claims = await listPendingPaymentClaims();

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
                  <div>
                    <dt className="text-muted">Proof</dt>
                    <dd>
                      {c.proof_url ? (
                        <a href={c.proof_url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                          Link
                        </a>
                      ) : (
                        '—'
                      )}
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
    </div>
  );
}
