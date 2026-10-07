import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireClient } from '@/lib/auth/session';
import { formatMinor } from '@/modules/finance/phase-nine-view';
import { readClientStatement } from '@/modules/portal/client-action-queries';
import { readClientProject } from '@/modules/portal/queries';
import { IconArrowLeft } from '@/ui';

export const metadata: Metadata = { title: 'Statement' };

const humanize = (s: string) => s.replace(/_/g, ' ');

/**
 * The client's financial statement for this project (Phase 7c, P710 §10): what was invoiced, the payments a person at the agency verified as received, and what
 * is outstanding. FACTS only, read through client-safe database functions that filter by your own account: this page cannot change an amount, record a payment or
 * waive anything. A payment you reported that has not been verified yet is not counted as received.
 */
export default async function PortalStatementPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requireClient();
  const clock = await agencyClock();
  const { projectId } = await params;
  const project = await readClientProject(projectId);
  if (!project) notFound();
  const { invoices, payments, totals } = await readClientStatement(projectId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href={`/portal/${projectId}`} className="flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-foreground">
          <IconArrowLeft size={14} />
          {project.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Statement</h1>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-[15px] font-medium">Summary</h2>
        {totals.length === 0 ? (
          <p className="text-sm text-muted">Nothing has been invoiced yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {totals.map((t) => (
              <li key={t.currency} className="rounded-lg border border-line bg-surface px-4 py-2 text-sm">
                Invoiced {formatMinor(t.invoicedMinor, t.currency)} · Received and verified {formatMinor(t.verifiedMinor, t.currency)} · <strong>Outstanding {formatMinor(t.outstandingMinor, t.currency)}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[15px] font-medium">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted">No invoice has been issued.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {invoices.map((i) => (
              <li key={i.invoiceId} className="flex flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{i.number}</span>
                  <span className="text-[12px] text-muted">{i.overdue ? 'overdue' : humanize(i.status)}</span>
                </div>
                <span>
                  Total {formatMinor(i.totalMinor, i.currency)} · verified paid {formatMinor(i.verifiedMinor, i.currency)} · outstanding {formatMinor(i.outstandingMinor, i.currency)}
                  {i.recordedUnverifiedMinor > 0 ? ` · ${formatMinor(i.recordedUnverifiedMinor, i.currency)} recorded and awaiting verification` : ''}
                </span>
                <span className="text-[12px] text-muted">
                  {i.issuedAt ? `Issued ${clock.date(i.issuedAt)}` : ''}
                  {i.dueAt ? ` · due ${clock.date(i.dueAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[15px] font-medium">Payments received</h2>
        {payments.length === 0 ? (
          <p className="text-sm text-muted">No verified payment yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {payments.map((p) => (
              <li key={p.paymentId} className="rounded-lg border border-line bg-surface px-4 py-2 text-sm">
                {formatMinor(p.amountMinor, p.currency)} on {clock.date(p.verifiedAt)} for {p.invoiceNumber}
                {p.receiptNumber ? ` · receipt ${p.receiptNumber}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
