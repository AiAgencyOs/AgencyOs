import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { Badge, DataTable, DetailList, DetailPanel, DetailRow, StatusBadge, PermissionDenied } from '@/ui';
import { can } from '@/lib/authz/permissions';
import {
  getClientAccountName,
  getInvoice,
  listInvoiceItems,
  listInvoicePayments,
  listInvoiceReceipts,
  listInvoicePaymentClaims,
  listPaymentAccounts,
  listRefunds,
  readInvoiceBillingProfile,
  readNetReceived,
} from '@/modules/finance/queries';
import {
  displayPaymentReference,
  PAYMENT_ACCOUNT_FIELDS,
  PAYMENT_ACCOUNT_KIND_LABEL,
  PAYABLE_INVOICE_STATUSES,
  PAYMENT_METHODS,
  type InvoiceStatus,
} from '@/modules/finance/schema';
import { getProject, listPaymentPlan } from '@/modules/projects/queries';
import { listInvoiceSends } from '@/modules/finance/sends-queries';
import { INVOICE_SEND_CHANNEL_LABEL, needsReminder, type InvoiceSendChannel } from '@/modules/finance/sends-schema';
import { buttonClass } from '@/ui';

import { RecordRefundForm, RequestRefundForm } from './refund-panel';
import { RecordInvoiceSendForm } from './send-panel';

import { IssueInvoiceForm, RecordPaymentForm, VoidInvoiceForm,
  VerifyPaymentButton,
} from './invoice-panel';

export const metadata: Metadata = { title: 'Invoice' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

/** Minor units as a plain decimal, for pre-filling an amount field. */
function majorUnits(minor: number): string {
  return (minor / 100).toFixed(2);
}

function when(clock: AgencyClock, value: string | null): string {
  return value ? clock.date(value) : '—';
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

  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) return <PermissionDenied />;

  const invoice = await getInvoice(invoiceId);
  if (!invoice) notFound();

  const [items, payments, receipts, clientName, project, billing, claims, accounts, sends] = await Promise.all([
    listInvoiceItems(invoiceId),
    listInvoicePayments(invoiceId),
    listInvoiceReceipts(invoiceId),
    getClientAccountName(invoice.client_account_id),
    invoice.project_id ? getProject(invoice.project_id) : Promise.resolve(null),
    readInvoiceBillingProfile(invoice.project_id),
    listInvoicePaymentClaims(invoiceId),
    listPaymentAccounts(),
    listInvoiceSends(invoiceId),
  ]);
  const lastReminderAt = sends.find((s) => s.kind === 'reminder')?.sentAt ?? null;
  const reminderDue = needsReminder(invoice, lastReminderAt, new Date());
  const receivingAccounts = accounts.filter((a) => a.status === 'active');
  const taxRatePct = invoice.subtotal_minor > 0 ? Math.round((invoice.tax_minor / invoice.subtotal_minor) * 1000) / 10 : 0;

  // The milestone name comes from the plan the project page already renders,
  // so the two screens agree on what a milestone is called.
  const milestone = invoice.milestone_id
    ? (await listPaymentPlan(invoice.project_id ?? '')).find((m) => m.id === invoice.milestone_id)
    : undefined;

  const status = invoice.status as InvoiceStatus;
  const outstanding = invoice.total_minor - invoice.paid_minor;

  const mayIssue = can(context.role, 'invoice.issue');
  // Owner-only, and has been since the capability matrix was written. This is
  // its first caller.
  const mayRefund = can(context.role, 'refund.issue');
  const [refunds, netReceived] = await Promise.all([
    listRefunds(invoice.id),
    readNetReceived(invoice.id),
  ]);
  const isDraft = status === 'draft' || status === 'pending_approval';
  const isPayable = PAYABLE_INVOICE_STATUSES.includes(status);
  const mayVoid = status !== 'void' && status !== 'paid' && invoice.paid_minor === 0;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Invoice</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold tracking-tight sm:text-2xl">
            {invoice.number}
          </h1>
          <StatusBadge status={status} />
          {reminderDue ? <Badge tone="warning">needs a reminder</Badge> : null}
          <a
            href={`/api/invoices/${invoice.id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className={buttonClass('secondary', 'sm')}
          >
            Open PDF{isDraft ? ' (draft)' : ''}
          </a>
        </div>
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
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
          ['Due', when(clock, invoice.due_at)],
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col gap-1 rounded-lg border border-line bg-surface px-3 py-2"
          >
            <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
            <span className="font-mono text-sm">{value}</span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Lines</h2>
        <DataTable
          rows={items}
          columns={[
            { key: 'description', header: 'Description', primary: true, cell: (i) => i.description },
            {
              key: 'qty',
              header: 'Qty',
              align: 'right',
              cellClassName: 'tabular text-muted',
              cell: (i) => i.quantity,
            },
            {
              key: 'unit',
              header: 'Unit',
              align: 'right',
              cellClassName: 'tabular',
              cell: (i) => money(i.unit_price_minor, invoice.currency),
            },
            {
              key: 'amount',
              header: 'Amount',
              align: 'right',
              cellClassName: 'tabular font-medium',
              cell: (i) => money(i.amount_minor, invoice.currency),
            },
          ]}
          getKey={(i) => i.id}
        />

        <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,20rem)]">
          <div className="flex flex-col gap-4">
            <DetailPanel
              title="Billed to"
              rows={[
                { label: 'Client', value: clientName ?? '—' },
                { label: 'Legal name', value: billing?.legalName ?? '—' },
                {
                  label: 'Billing mode',
                  value: billing ? (
                    <Badge tone={billing.mode === 'gst' ? 'brand' : 'neutral'} mono>
                      {billing.mode === 'gst' ? 'GST' : 'Non-GST'} · v{billing.version}
                    </Badge>
                  ) : (
                    <span className="text-warning">not confirmed</span>
                  ),
                },
                { label: 'GSTIN', value: billing?.gstin ? <span className="font-mono text-xs">{billing.gstin}</span> : '—' },
                { label: 'State', value: billing?.billingState ?? '—' },
                { label: 'Address', value: billing?.billingAddress ? <span className="whitespace-pre-line">{billing.billingAddress}</span> : '—' },
                { label: 'Confirmed', value: billing ? when(clock, billing.confirmedAt) : '—' },
              ]}
            />
            {milestone && project ? (
              <DetailPanel
                title="Linked milestone"
                rows={[
                  { label: 'Milestone', value: `${milestone.position + 1}. ${milestone.name}` },
                  { label: 'Project', value: <Link href={`/projects/${project.id}`} className="hover:underline">{project.name}</Link> },
                  { label: 'Share', value: `${milestone.payment_percent}% of the plan` },
                  { label: 'Milestone value', value: <span className="tabular">{money(milestone.amount_minor, invoice.currency)}</span> },
                  { label: 'Plan', value: <Link href={`/projects/${project.id}/plan`} className="text-brand hover:underline">Open payment plan</Link> },
                ]}
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-line bg-surface px-4 shadow-xs">
              <DetailList>
                <DetailRow
                  label="Subtotal"
                  value={<span className="tabular">{money(invoice.subtotal_minor, invoice.currency)}</span>}
                />
                <DetailRow
                  label={billing?.mode === 'gst' ? `GST${taxRatePct ? ` @ ${taxRatePct}%` : ''}` : 'Tax'}
                  value={<span className="tabular">{money(invoice.tax_minor, invoice.currency)}</span>}
                />
                <DetailRow
                  label={<span className="font-semibold text-foreground">Total</span>}
                  value={
                    <span className="tabular text-base font-semibold">
                      {money(invoice.total_minor, invoice.currency)}
                    </span>
                  }
                />
                <DetailRow
                  label="Paid"
                  value={<span className="tabular text-success">{money(invoice.paid_minor, invoice.currency)}</span>}
                />
                <DetailRow
                  label="Outstanding"
                  value={<span className={`tabular ${outstanding > 0 ? 'text-warning' : ''}`}>{money(outstanding, invoice.currency)}</span>}
                />
              </DetailList>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 shadow-xs">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[13px] font-semibold tracking-tight">Pay into</h3>
                <Link href="/settings/finance" className="text-xs text-brand hover:underline">Manage</Link>
              </div>
              {receivingAccounts.length === 0 ? (
                <p className="text-xs text-muted">No active receiving account. Add one under Settings › Finance so the client knows where to pay.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {receivingAccounts.map((a) => (
                    <li key={a.id} className="rounded-lg border border-line bg-canvas px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{a.label}</span>
                        <Badge mono>{PAYMENT_ACCOUNT_KIND_LABEL[a.kind]}</Badge>
                      </div>
                      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                        {PAYMENT_ACCOUNT_FIELDS[a.kind]
                          .filter((f) => a.instructions[f.key])
                          .map((f) => (
                            <div key={f.key} className="contents">
                              <dt className="text-muted">{f.label}</dt>
                              <dd className="font-mono">{a.instructions[f.key]}</dd>
                            </div>
                          ))}
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
        {invoice.notes ? (
          <p className="whitespace-pre-line text-sm text-muted">{invoice.notes}</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">
          Payments <span className="text-muted">({payments.length})</span>
        </h2>

        {payments.length > 0 ? (
          <DataTable
            rows={payments}
            columns={[
              {
                key: 'received',
                header: 'Received',
                primary: true,
                cell: (p) => when(clock, p.captured_at),
              },
              {
                key: 'amount',
                header: 'Amount',
                align: 'right',
                cellClassName: 'tabular font-medium',
                cell: (p) => money(p.amount_minor, p.currency),
              },
              {
                key: 'source',
                header: 'Source',
                badge: true,
                cell: (p) => (
                  <Badge mono>{p.provider === 'manual' ? 'recorded by hand' : p.provider}</Badge>
                ),
              },
              {
                key: 'reference',
                header: 'Reference',
                align: 'right',
                cellClassName: 'font-mono text-xs text-muted',
                cell: (p) => displayPaymentReference(p.provider_payment_id),
              },
              {
                /*
                  G-270. Recorded and confirmed are two different facts (ADM-04,
                  G-007) and this table showed only the first, so an Admin could
                  not tell a client's claim from money they had seen — on the one
                  page where that distinction decides whether an invoice is paid.
                */
                key: 'verified',
                header: 'Confirmed',
                align: 'right',
                cell: (p) =>
                  p.verified_at ? (
                    <span className="text-success">confirmed {when(clock, p.verified_at)}</span>
                  ) : mayIssue && p.status === 'captured' ? (
                    <VerifyPaymentButton
                      paymentId={p.id}
                      invoiceId={invoiceId}
                      projectId={invoice.project_id}
                    />
                  ) : (
                    /*
                      Said rather than left blank. A blank cell reads as "no
                      information"; this is a claim nobody has checked, and the
                      invoice cannot become paid until somebody does.
                    */
                    <span className="text-muted">not confirmed yet</span>
                  ),
              },
            ]}
            getKey={(p) => p.id}
          />
        ) : (
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
            No payments recorded. An invoice is never marked paid on its own — somebody records
            money, and then somebody confirms they have seen it on the statement (ADM-04). Both
            steps, or the invoice stays unpaid and the next milestone stays shut.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">
          Payment claims <span className="text-muted">({claims.length})</span>
        </h2>
        {claims.length > 0 ? (
          <DataTable
            rows={claims}
            dense
            columns={[
              { key: 'submitted', header: 'Submitted', primary: true, cell: (c) => when(clock, c.submitted_at) },
              { key: 'amount', header: 'Amount', align: 'right', cellClassName: 'tabular font-medium', cell: (c) => money(c.amount_minor, c.currency) },
              { key: 'method', header: 'Method', badge: true, cell: (c) => <Badge mono>{c.method}</Badge> },
              { key: 'reference', header: 'Reference', cellClassName: 'font-mono text-xs text-muted', cell: (c) => c.reference ?? '—' },
              { key: 'payer', header: 'Payer', cellClassName: 'text-muted', cell: (c) => c.payer_name ?? '—' },
              { key: 'status', header: 'Status', badge: true, cell: (c) => <StatusBadge status={c.status} /> },
              {
                key: 'outcome',
                header: 'Outcome',
                align: 'right',
                cellClassName: 'text-xs text-muted',
                cell: (c) =>
                  c.verified_at
                    ? `verified ${when(clock, c.verified_at)}`
                    : c.rejected_reason
                      ? `rejected: ${c.rejected_reason}`
                      : c.mismatch_note
                        ? `mismatch: ${c.mismatch_note}`
                        : c.status === 'pending_verification'
                          ? 'awaiting verification'
                          : '—',
              },
            ]}
            getKey={(c) => c.id}
          />
        ) : (
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
            No claims submitted. A claim is what a client (or an admin on their behalf) says was paid; it becomes a payment above only once somebody verifies it under <Link href="/invoices/verify" className="text-brand hover:underline">Verify payments</Link>.
          </p>
        )}
      </section>

      {/*
        Sent / reminders — SCR-051. The record of somebody sending this bill
        and chasing it. Records only: the PDF above is what they send.
      */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">
          Sent / reminders <span className="text-muted">({sends.length})</span>
        </h2>
        {sends.length > 0 ? (
          <DataTable
            rows={sends}
            dense
            columns={[
              { key: 'when', header: 'When', primary: true, cell: (s) => clock.dateTime(s.sentAt) },
              { key: 'kind', header: 'What', badge: true, cell: (s) => <Badge tone={s.kind === 'reminder' ? 'warning' : 'brand'}>{s.kind === 'reminder' ? 'reminder' : 'sent'}</Badge> },
              { key: 'channel', header: 'On', cellClassName: 'text-muted', cell: (s) => INVOICE_SEND_CHANNEL_LABEL[s.channel as InvoiceSendChannel] ?? s.channel },
              { key: 'by', header: 'By', cellClassName: 'text-muted', cell: (s) => s.sentByName ?? '—' },
              { key: 'ref', header: 'Reference', cellClassName: 'font-mono text-xs text-muted', cell: (s) => s.messageRef ?? '—' },
              { key: 'note', header: 'Note', cellClassName: 'text-muted', cell: (s) => s.note ?? '—' },
            ]}
            getKey={(s) => s.id}
          />
        ) : (
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
            {isDraft
              ? 'A draft has not been sent. Issue it, open the PDF, send it yourself, then record that here.'
              : 'Nobody has recorded sending this invoice. Open the PDF, send it, then record that here so the list can say when it was last chased.'}
          </p>
        )}
        {mayIssue && !isDraft && status !== 'void' ? (
          <RecordInvoiceSendForm invoiceId={invoice.id} defaultKind={sends.some((s) => s.kind === 'sent') ? 'reminder' : 'sent'} />
        ) : null}
      </section>

      {/*
        Receipts — Finance Agent spec §14. One per verified payment, generated
        by finance.verify_payment itself; shown only when at least one exists,
        the same restraint the refunds section below keeps.
      */}
      {receipts.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold tracking-tight">
            Receipts <span className="text-muted">({receipts.length})</span>
          </h2>

          <DataTable
            rows={receipts}
            columns={[
              {
                key: 'number',
                header: 'Receipt',
                primary: true,
                cellClassName: 'font-mono text-xs',
                cell: (r) => r.number,
              },
              {
                key: 'amount',
                header: 'Amount',
                align: 'right',
                cellClassName: 'tabular font-medium',
                cell: (r) => money(r.amount_minor, r.currency),
              },
              {
                key: 'issued',
                header: 'Issued',
                align: 'right',
                cell: (r) => when(clock, r.issued_at),
              },
            ]}
            getKey={(r) => r.id}
          />
        </section>
      ) : null}

      {/*
        Refunds — G-005. Two controls with a gap between them on purpose:
        asking raises an approval and moves nothing, recording says the
        transfer happened. One control doing both would be a refund with no
        approval behind it.
      */}
      {refunds.length > 0 || mayRefund ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold tracking-tight">Refunds</h2>

          {refunds.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {refunds.map((refund) => (
                <li
                  key={refund.id}
                  className="rounded-lg border border-line bg-surface px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium tabular">
                      {money(refund.amount_minor, invoice.currency)}
                    </span>
                    <span className="text-xs text-muted">
                      {refund.status === 'recorded'
                        ? `left ${when(clock, refund.recorded_at)}`
                        : 'waiting on an owner’s approval'}
                    </span>
                  </div>

                  <p className="mt-1 text-muted">{refund.reason}</p>

                  {refund.provider_refund_id ? (
                    <p className="mt-1 text-xs text-muted">Reference: {refund.provider_refund_id}</p>
                  ) : null}

                  {mayRefund && refund.status === 'requested' ? (
                    <RecordRefundForm refundId={refund.id} invoiceId={invoice.id} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {mayRefund && netReceived > 0 ? (
            <details className="rounded-lg border border-line bg-surface px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Request a refund</summary>
              <div className="pt-3">
                <RequestRefundForm
                  invoiceId={invoice.id}
                  availableMajor={majorUnits(netReceived)}
                  currency={invoice.currency}
                />
              </div>
            </details>
          ) : null}

          {mayRefund && netReceived === 0 ? (
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
              Nothing has been received on this invoice, so there is nothing to refund.
            </p>
          ) : null}
        </section>
      ) : null}

      {mayIssue ? (
        <section className="flex flex-col gap-5">
          <h2 className="text-[13px] font-semibold tracking-tight">Actions</h2>

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
            <details className="rounded-lg border border-line bg-surface px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Void this invoice</summary>
              <div className="pt-3">
                <VoidInvoiceForm invoiceId={invoice.id} projectId={invoice.project_id} />
              </div>
            </details>
          ) : null}

          {status === 'paid' ? (
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
              Paid in full on {when(clock, invoice.paid_at)}. Nothing further to do here.
            </p>
          ) : null}
          {status === 'void' ? (
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
              This invoice was voided. Its milestone can be invoiced again.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
