import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getPaymentDetail } from '@/modules/finance/payment-detail-queries';
import { Badge, buttonClass, Callout, Card, CardHeader, DetailPanel, humanize, PageHeader, PermissionDenied, StatusBadge } from '@/ui';

import { VerifyPaymentButton } from '../../../invoices/[invoiceId]/invoice-panel';

export const metadata: Metadata = { title: 'Payment' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
}

/**
 * One payment — PDF SCR-053 "Payment detail": what it is, the proof and
 * evidence behind it, the invoice it matches and where the invoice stands,
 * the receipt, the bank lines that agree, and the reconciliation notes.
 * Read-only apart from the one human step that belongs here: confirming a
 * recorded payment somebody has seen on the statement (the same door the
 * invoice page uses). Client proof or a recorded payment is NOT a verified
 * payment (PDF guardrail) and this page says which one it is.
 */
export default async function PaymentDetailPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  const context = await requireInternal(`/finance/payments/${paymentId}`);
  const clock = await agencyClock();
  if (!can(context, 'invoice.read')) return <PermissionDenied />;
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) notFound();

  const payment = await getPaymentDetail(paymentId);
  if (!payment) notFound();

  const mayVerify = can(context, 'invoice.issue');
  const verified = payment.verifiedAt !== null && payment.status === 'captured';
  const owed = Math.max(0, payment.invoiceTotalMinor - payment.invoiceVerifiedMinor);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Payment ${payment.reference}`}
        description={`${money(payment.amountMinor, payment.currency)} on ${payment.invoiceNumber}${payment.clientName ? ` · ${payment.clientName}` : ''}`}
        actions={
          <>
            <Link href="/finance/payments" className={buttonClass('secondary', 'sm')}>All payments</Link>
            <Link href={`/invoices/${payment.invoiceId}`} className={buttonClass('primary', 'sm')}>Open invoice</Link>
          </>
        }
      />

      {!verified && payment.status === 'captured' ? (
        <Callout tone="warning">
          <span className="flex flex-wrap items-center gap-3">
            Recorded, not verified: this money is not counted as received until a person confirms they have seen it on the bank statement.
            {mayVerify ? <VerifyPaymentButton paymentId={payment.id} invoiceId={payment.invoiceId} projectId={payment.projectId} /> : null}
          </span>
        </Callout>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <DetailPanel
          title="Payment"
          rows={[
            { label: 'Status', value: <StatusBadge status={verified ? 'verified' : payment.status} dot={false} /> },
            { label: 'Amount', value: <span className="tabular">{money(payment.amountMinor, payment.currency)}</span> },
            { label: 'Source', value: <Badge mono>{payment.provider === 'manual' ? 'recorded by hand' : payment.provider}</Badge> },
            { label: 'Reference', value: <span className="font-mono text-xs">{payment.reference}</span> },
            { label: 'Captured', value: payment.capturedAt ? clock.dateTime(payment.capturedAt) : '—' },
            { label: 'Verified', value: payment.verifiedAt ? `${clock.dateTime(payment.verifiedAt)}${payment.verifiedByName ? ` by ${payment.verifiedByName}` : ''}` : 'Not yet' },
            { label: 'Receipt', value: payment.receipt ? <span className="font-mono text-xs">{payment.receipt.number} · {clock.date(payment.receipt.issuedAt)}</span> : 'None until verified' },
          ]}
        />
        <DetailPanel
          title="Invoice match"
          rows={[
            { label: 'Invoice', value: <Link href={`/invoices/${payment.invoiceId}`} className="font-mono text-xs text-brand hover:underline">{payment.invoiceNumber}</Link> },
            { label: 'Invoice status', value: <StatusBadge status={payment.invoiceStatus} dot={false} /> },
            { label: 'Invoice total', value: <span className="tabular">{money(payment.invoiceTotalMinor, payment.currency)}</span> },
            { label: 'Verified so far', value: <span className="tabular">{money(payment.invoiceVerifiedMinor, payment.currency)}</span> },
            { label: 'Still owed', value: <span className="tabular">{money(owed, payment.currency)}</span> },
            ...(payment.projectId ? [{ label: 'Project', value: <Link href={`/projects/${payment.projectId}`} className="text-brand hover:underline">Open project</Link> }] : []),
          ]}
        />
      </div>

      <Card>
        <CardHeader title="Proof and evidence" description="What a client submitted, and what a person checked. A claim is not money; the verified payment above is." />
        {payment.claims.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No client claim is attached to this payment. It was recorded directly{payment.verifiedAt ? ' and confirmed against the statement' : ''}.</p>
        ) : (
          <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
            {payment.claims.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 py-3 text-[13px]">
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={c.status} dot={false} />
                  <span className="text-muted">{humanize(c.method)}{c.reference ? ` · ${c.reference}` : ''}{c.payerName ? ` · ${c.payerName}` : ''}</span>
                  <span className="ml-auto text-xs text-muted">{clock.dateTime(c.submittedAt)}</span>
                </span>
                {c.proofUrl ? (
                  <a href={c.proofUrl} target="_blank" rel="noreferrer" className="w-fit text-brand hover:underline">Open the submitted proof</a>
                ) : (
                  <span className="text-muted">No proof link was attached.</span>
                )}
                {c.verificationEvidence ? <span><span className="text-muted">Checked: </span>{c.verificationEvidence}</span> : null}
                {c.rejectedReason ? <span><span className="text-muted">Rejected: </span>{c.rejectedReason}</span> : null}
                {c.mismatchNote ? <span><span className="text-muted">Mismatch: </span>{c.mismatchNote}</span> : null}
                {c.evidenceRequestNote ? <span><span className="text-muted">More evidence asked for: </span>{c.evidenceRequestNote}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Reconciliation notes" description="Bank statement lines that point at this payment, and lines that agree on amount or reference (a reading, never a match)." />
        <div className="flex flex-col gap-3 px-4 pb-4 text-[13px] sm:px-5">
          {payment.reconciliation.length === 0 && payment.bankLines.length === 0 ? (
            <p className="text-muted">Nothing on a statement refers to this payment yet. <Link href="/finance/payments#reconciliation" className="text-brand hover:underline">Open reconciliation</Link></p>
          ) : null}
          {payment.reconciliation.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {payment.reconciliation.map((i) => (
                <li key={i.id}>
                  <Badge tone={i.finding === 'matched' ? 'success' : 'warning'}>{humanize(i.finding)}</Badge>{' '}
                  <span className="font-mono text-xs">{i.statementLine}</span> · {clock.date(i.statementDate)}
                  {i.reason ? <span className="text-muted"> — {i.reason}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {payment.bankLines.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {payment.bankLines.map((l) => (
                <li key={l.id}>
                  <span className="font-mono text-xs">{l.description}</span> · {clock.date(l.statementDate)} · <span className="tabular">{money(l.amountMinor, payment.currency)}</span>
                  {l.reference ? <span className="text-muted"> · {l.reference}</span> : null}
                  <span className="text-muted"> · {l.status}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
