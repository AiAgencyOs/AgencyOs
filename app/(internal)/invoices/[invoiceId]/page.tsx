import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getClientAccountName,
  getInvoice,
  listInvoiceItems,
  listInvoicePayments,
} from '@/modules/finance/queries';
import {
  displayPaymentReference,
  PAYABLE_INVOICE_STATUSES,
  PAYMENT_METHODS,
  type InvoiceStatus,
} from '@/modules/finance/schema';
import { getProject, listPaymentPlan } from '@/modules/projects/queries';

import { IssueInvoiceForm, RecordPaymentForm, VoidInvoiceForm } from './invoice-panel';

export const metadata: Metadata = { title: 'Invoice · AgencyOS' };

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

/** Minor units as a plain decimal, for pre-filling an amount field. */
function majorUnits(minor: number): string {
  return (minor / 100).toFixed(2);
}

function when(value: string | null): string {
  return value ? DATE.format(new Date(value)) : '—';
}

/**
 * A single invoice: what it bills, what it is worth, and what has been paid.
 *
 * This is the draft-invoice view the milestone billing flow hands off to, and
 * the only place an invoice's status changes. It stays deliberately plain — a
 * bill is a document, and the reader's questions are who, how much, for what,
 * and has it been paid.
 */
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;

  const context = await requireInternal(`/invoices/${invoiceId}`);
  if (!can(context.role, 'invoice.read')) redirect('/dashboard');

  const invoice = await getInvoice(invoiceId);
  if (!invoice) notFound();

  const [items, payments, clientName, project] = await Promise.all([
    listInvoiceItems(invoiceId),
    listInvoicePayments(invoiceId),
    getClientAccountName(invoice.client_account_id),
    invoice.project_id ? getProject(invoice.project_id) : Promise.resolve(null),
  ]);

  // The milestone name comes from the plan the project page already renders,
  // so the two screens agree on what a milestone is called.
  const milestone = invoice.milestone_id
    ? (await listPaymentPlan(invoice.project_id ?? '')).find((m) => m.id === invoice.milestone_id)
    : undefined;

  const status = invoice.status as InvoiceStatus;
  const outstanding = invoice.total_minor - invoice.paid_minor;

  const mayIssue = can(context.role, 'invoice.issue');
  const isDraft = status === 'draft' || status === 'pending_approval';
  const isPayable = PAYABLE_INVOICE_STATUSES.includes(status);
  const mayVoid = status !== 'void' && status !== 'paid' && invoice.paid_minor === 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wide text-muted">Invoice</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold tracking-tight">{invoice.number}</h1>
          <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
            {status}
          </span>
        </div>
        <p className="text-sm text-muted">
          {clientName ?? 'Client account'}
          {project ? (
            <>
              {' · '}
              <Link href={`/projects/${project.id}`} className="hover:underline">
                {project.name}
              </Link>
            </>
          ) : null}
          {milestone ? ` · milestone ${milestone.position + 1}: ${milestone.name}` : null}
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['Total', money(invoice.total_minor, invoice.currency)],
          ['Paid', money(invoice.paid_minor, invoice.currency)],
          ['Outstanding', money(outstanding, invoice.currency)],
          ['Due', when(invoice.due_at)],
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col gap-1 rounded-lg border border-black/10 px-3 py-2 dark:border-white/15"
          >
            <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
            <span className="font-mono text-sm">{value}</span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Lines</h2>
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left dark:border-white/15">
                {['Description', 'Qty', 'Unit', 'Amount'].map((h) => (
                  <th key={h} className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-black/5 last:border-0 dark:border-white/10">
                  <td className="px-4 py-3">{item.description}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{item.quantity}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {money(item.unit_price_minor, invoice.currency)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {money(item.amount_minor, invoice.currency)}
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="px-4 py-3 text-right text-xs uppercase tracking-wide text-muted">
                  Subtotal
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {money(invoice.subtotal_minor, invoice.currency)}
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="px-4 py-3 text-right text-xs uppercase tracking-wide text-muted">
                  Tax
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {money(invoice.tax_minor, invoice.currency)}
                </td>
              </tr>
              <tr className="border-t border-black/10 dark:border-white/15">
                <td colSpan={3} className="px-4 py-3 text-right text-xs uppercase tracking-wide text-muted">
                  Total
                </td>
                <td className="px-4 py-3 font-mono text-sm font-medium">
                  {money(invoice.total_minor, invoice.currency)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {invoice.notes ? (
          <p className="whitespace-pre-line text-sm text-muted">{invoice.notes}</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          Payments <span className="text-muted">({payments.length})</span>
        </h2>

        {payments.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left dark:border-white/15">
                  {['Received', 'Amount', 'Source', 'Reference'].map((h) => (
                    <th key={h} className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr
                    key={payment.id}
                    className="border-b border-black/5 last:border-0 dark:border-white/10"
                  >
                    <td className="px-4 py-3 text-muted">{when(payment.captured_at)}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {money(payment.amount_minor, payment.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
                        {payment.provider === 'manual' ? 'recorded by hand' : payment.provider}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">
                      {displayPaymentReference(payment.provider_payment_id)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">
            No payments recorded. An invoice is never marked paid on its own — somebody records
            money they have seen arrive.
          </p>
        )}
      </section>

      {mayIssue ? (
        <section className="flex flex-col gap-5">
          <h2 className="text-sm font-medium">Actions</h2>

          {isDraft ? (
            <IssueInvoiceForm
              invoiceId={invoice.id}
              projectId={invoice.project_id}
              dueOn={invoice.due_at ? invoice.due_at.slice(0, 10) : null}
            />
          ) : null}

          {isPayable ? (
            <RecordPaymentForm
              invoiceId={invoice.id}
              projectId={invoice.project_id}
              outstandingMajor={majorUnits(outstanding)}
              currency={invoice.currency}
              methods={PAYMENT_METHODS}
            />
          ) : null}

          {mayVoid ? (
            <details className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15">
              <summary className="cursor-pointer text-sm font-medium">Void this invoice</summary>
              <div className="pt-3">
                <VoidInvoiceForm invoiceId={invoice.id} projectId={invoice.project_id} />
              </div>
            </details>
          ) : null}

          {status === 'paid' ? (
            <p className="text-sm text-muted">
              Paid in full on {when(invoice.paid_at)}. Nothing further to do here.
            </p>
          ) : null}
          {status === 'void' ? (
            <p className="text-sm text-muted">
              This invoice was voided. Its milestone can be invoiced again.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
