import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInvoices } from '@/modules/finance/queries';

export const metadata: Metadata = { title: 'Invoices · AgencyOS' };

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Minor units → display string, in the currency the invoice was raised in. */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/**
 * Invoice list.
 *
 * Same two-layer gate as the leads page: the capability is re-checked because
 * hiding the nav entry is not access control, and RLS refuses the rows
 * independently of both.
 */
export default async function InvoicesPage() {
  const context = await requireInternal('/invoices');
  if (!can(context.role, 'invoice.read')) redirect('/dashboard');

  const invoices = await listInvoices();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Invoices</h1>
        <p className="text-sm text-muted">
          {invoices.length === 0
            ? 'No invoices raised yet.'
            : `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}.`}
        </p>
      </div>

      {invoices.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
          <table className="w-full min-w-[46rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left dark:border-white/15">
                {['Number', 'Status', 'Total', 'Paid', 'Issued', 'Due'].map((h) => (
                  <th key={h} className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr
                  key={invoice.id}
                  className="border-b border-black/5 last:border-0 dark:border-white/10"
                >
                  <td className="px-4 py-3 font-mono text-xs font-medium">
                    <Link href={`/invoices/${invoice.id}`} className="hover:underline">
                      {invoice.number}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
                      {invoice.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {money(invoice.total_minor, invoice.currency)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    {money(invoice.paid_minor, invoice.currency)}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {invoice.issued_at ? DATE.format(new Date(invoice.issued_at)) : '—'}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {invoice.due_at ? DATE.format(new Date(invoice.due_at)) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-black/15 px-4 py-8 text-center text-sm text-muted dark:border-white/20">
          Invoices raised against project milestones will appear here.
        </p>
      )}
    </div>
  );
}
