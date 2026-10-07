import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';
import { listCreditNotes } from '@/modules/finance/p1o-credit-notes';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, buttonClass } from '@/ui';

import { IssueCreditNoteForm, LinkReplacementForm, RequestCreditNoteForm } from './credit-note-forms';

export const metadata: Metadata = { title: 'Credit notes' };

const money = (minor: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(minor / 100);

/**
 * Credit notes (P2-FIN-038, P4-FIN-021). An issued invoice does not change; a reduction is a separate document the owner approved. This page lists them, lets an
 * administrator or finance member request one against an issued invoice, issues it once the owner's approval is in, and links the replacement invoice when the
 * correction is a reissue. It refunds nothing and files nothing: the refund door and the GST filing are separate.
 */
export default async function CreditNotesPage() {
  const context = await requireInternal('/invoices/credit-notes');
  if (!can(context, 'invoice.read')) return <PermissionDenied />;
  const canAct = can(context, 'invoice.issue');

  const notes = await listCreditNotes();
  const supabase = await createClient();
  const { data: invoices, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, status, total_minor')
    .in('status', ['issued', 'partially_paid', 'paid', 'overdue'])
    .order('issued_at', { ascending: false })
    .limit(200);
  if (error) unreadable('creditNotes.invoices', error);
  const options = (invoices ?? []).map((i) => ({ id: i.id, label: `${i.number} · ${money(i.total_minor)} · ${i.status.replace('_', ' ')}` }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Credit notes" description="A correction to an issued invoice, approved by the owner and numbered. The invoice itself is never edited." actions={<Link href="/invoices" className={buttonClass('secondary', 'sm')}>Invoices</Link>} />

      {canAct && options.length > 0 ? (
        <Card><CardHeader title="Request a credit note" description="The owner is asked to approve it. Pending requests count against the invoice's remaining room." /><CardBody><RequestCreditNoteForm invoices={options} /></CardBody></Card>
      ) : null}

      {notes.length === 0 ? (
        <EmptyState title="No credit notes" description="None has been requested yet." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="bg-surface text-xs uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Number</th><th className="px-3 py-2">Invoice</th><th className="px-3 py-2">Credit</th><th className="px-3 py-2">Of which tax</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Status</th>{canAct ? <th className="px-3 py-2"></th> : null}</tr></thead>
            <tbody>
              {notes.map((n) => (
                <tr key={n.id} className="border-t border-line align-top">
                  <td className="px-3 py-2 font-mono text-xs">{n.number ?? 'not issued'}</td>
                  <td className="px-3 py-2">{n.invoiceNumber ?? n.invoiceId.slice(0, 8)}</td>
                  <td className="px-3 py-2">{money(n.amountMinor)}</td>
                  <td className="px-3 py-2">{money(n.taxMinor)}</td>
                  <td className="max-w-xs px-3 py-2 text-xs">{n.reason}</td>
                  <td className="px-3 py-2"><Badge tone={n.status === 'issued' ? 'success' : 'warning'} dot>{n.status === 'issued' ? 'issued' : 'awaiting owner approval'}</Badge>{n.replacementInvoiceId ? <span className="ml-2 text-xs text-muted">replacement linked</span> : null}</td>
                  {canAct ? (
                    <td className="px-3 py-2">
                      {n.status === 'requested' ? <IssueCreditNoteForm creditNoteId={n.id} /> : !n.replacementInvoiceId ? <LinkReplacementForm creditNoteId={n.id} invoices={options.filter((o) => o.id !== n.invoiceId)} /> : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
