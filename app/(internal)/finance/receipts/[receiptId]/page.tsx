import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { deliveryExplanation } from '@/modules/finance/p4s-receipt-shape';
import { readReceiptPage } from '@/modules/finance/p4s-receipt-queries';
import { Badge, buttonClass, Card, CardHeader, DetailPanel, humanize, PageHeader, PermissionDenied } from '@/ui';

export const metadata: Metadata = { title: 'Receipt' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
}

function instructionLines(instructions: unknown): string[] {
  if (!instructions || typeof instructions !== 'object') return [];
  return Object.entries(instructions as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => `${humanize(k)}: ${String(v)}`);
}

/**
 * One receipt (P4-FIN-042 / 057): the milestone, the client, the method and its reference, the date, the receiving account (masked), and, apart from the payment,
 * whether the receipt has reached the client on each channel. An unknown delivery is shown as unknown; nothing here sends, verifies or edits.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ receiptId: string }> }) {
  const { receiptId } = await params;
  const context = await requireInternal(`/finance/receipts/${receiptId}`);
  const clock = await agencyClock();
  if (!can(context, 'invoice.read')) return <PermissionDenied />;
  if (!/^[0-9a-f-]{36}$/i.test(receiptId)) notFound();

  const page = await readReceiptPage(receiptId);
  if (!page) notFound();
  const { document: d, deliveries } = page;
  const account = d.receivingAccount ? [d.receivingAccount.label, ...instructionLines(d.receivingAccount.instructions)].join(' · ') : 'Not recorded';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Receipt ${d.receiptNumber}`}
        description={`${money(d.amountMinor, d.currency)}${d.invoiceNumber ? ` on ${d.invoiceNumber}` : ''}${d.client ? ` · ${d.client}` : ''}`}
        actions={<Link href="/finance/payments" className={buttonClass('secondary', 'sm')}>All payments</Link>}
      />

      <DetailPanel
        title="Receipt"
        rows={[
          { label: 'Milestone', value: d.milestone ? `${d.milestone}${d.milestonePosition ? ` (M${d.milestonePosition})` : ''}` : '—' },
          { label: 'Client', value: d.client ?? '—' },
          { label: 'Amount', value: <span className="tabular">{money(d.amountMinor, d.currency)}</span> },
          { label: 'Method', value: d.method ? humanize(d.method) : '—' },
          { label: 'Transaction reference', value: d.transactionReference ? <span className="font-mono text-xs">{d.transactionReference}</span> : '—' },
          { label: 'Paid on', value: d.paidAt ? clock.date(d.paidAt) : '—' },
          { label: 'Receipt issued', value: clock.date(d.issuedAt) },
          { label: 'Receiving account', value: account },
        ]}
      />

      <Card>
        <CardHeader title="Delivery" description="Whether the receipt reached the client, recorded apart from the payment. Unknown means the outcome was not confirmed." />
        {deliveries.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No delivery has been recorded for this receipt.</p>
        ) : (
          <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
            {deliveries.map((x) => (
              <li key={x.channel} className="flex flex-col gap-1 py-3 text-[13px]">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={x.state === 'delivered' ? 'success' : x.state === 'failed' ? 'danger' : 'warning'}>{humanize(x.state)}</Badge>
                  <span>{humanize(x.channel)}</span>
                  <span className="ml-auto text-xs text-muted">{x.attempts} attempt(s) · {clock.dateTime(x.updatedAt)}</span>
                </span>
                <span className="text-muted">{deliveryExplanation(x.state)}</span>
                {x.evidence ? <span><span className="text-muted">Evidence: </span>{x.evidence}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
