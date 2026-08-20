import type { Metadata } from 'next';
import Link from 'next/link';

import { requireClient } from '@/lib/auth/session';
import { listClientInvoices, listClientProjects } from '@/modules/portal/queries';
import { DataTable, StatusBadge } from '@/ui';

export const metadata: Metadata = { title: 'Your projects' };

const MONEY = (currency: string) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 });

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The client portal — gap G-057.
 *
 * Until now this was nineteen lines saying "nothing to review yet", which was
 * true and is no longer: designs, prototypes, builds, progress and invoices
 * all exist, and the client they were made for could not see any of them.
 *
 * **There is no scoping code on this page.** Every read is RLS-scoped, proved
 * against a real database by `scripts/verify-client-portal.mjs`: a project
 * marked internal is invisible along with everything under it, a draft is
 * invisible until it is shown, a handover appears once delivered, and another
 * account's work is simply not there. A `client_account_id` predicate here
 * would be a second copy of that rule, and the copy that runs when somebody
 * calls the API directly is the one in the database.
 */
export default async function PortalPage() {
  await requireClient('/portal');

  const [projects, invoices] = await Promise.all([listClientProjects(), listClientInvoices()]);

  const outstanding = invoices
    .filter((i) => i.status !== 'paid' && i.status !== 'void')
    .reduce((sum, i) => sum + (i.total_minor - i.paid_minor), 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Your projects</h1>

        {projects.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface px-4 py-6 text-sm text-muted">
            Nothing has been shared with you yet. When your team publishes a design, a build or an
            invoice, it appears here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/portal/${project.id}`}
                  className="flex items-baseline justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 transition-colors hover:bg-surface-hover"
                >
                  <span className="text-sm font-medium">{project.name}</span>
                  <span className="text-xs text-muted">{project.status.replace('_', ' ')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Invoices</h2>

        {invoices.length === 0 ? (
          <p className="text-sm text-muted">No invoices yet.</p>
        ) : (
          <>
            <DataTable
              rows={invoices}
              columns={[
                { key: 'number', header: 'Invoice', primary: true, cell: (i) => i.number },
                {
                  key: 'status',
                  header: 'Status',
                  badge: true,
                  cell: (i) => <StatusBadge status={i.status} />,
                },
                {
                  key: 'due',
                  header: 'Due',
                  align: 'right',
                  cellClassName: 'text-muted',
                  cell: (i) => (i.due_at ? DATE.format(new Date(i.due_at)) : '—'),
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  align: 'right',
                  cellClassName: 'tabular font-medium',
                  cell: (i) => MONEY(i.currency).format(i.total_minor / 100),
                },
              ]}
              getKey={(i) => i.id}
            />

            {outstanding > 0 ? (
              <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
                Outstanding: {MONEY(invoices[0]!.currency).format(outstanding / 100)}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
