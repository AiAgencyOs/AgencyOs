import type { Metadata } from 'next';
import Link from 'next/link';

import { requireClient } from '@/lib/auth/session';
import { listClientInvoices, listClientProjects } from '@/modules/portal/queries';

export const metadata: Metadata = { title: 'Your projects · AgencyOS' };

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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Your projects</h1>

        {projects.length === 0 ? (
          <p className="rounded-lg border border-black/10 px-4 py-6 text-sm text-muted dark:border-white/15">
            Nothing has been shared with you yet. When your team publishes a design, a build or an
            invoice, it appears here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/portal/${project.id}`}
                  className="flex items-baseline justify-between gap-3 rounded-lg border border-black/10 px-4 py-3 transition-colors hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
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
        <h2 className="text-sm font-medium">Invoices</h2>

        {invoices.length === 0 ? (
          <p className="text-sm text-muted">No invoices yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
              <table className="w-full min-w-[32rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-black/10 text-left dark:border-white/15">
                    {['Invoice', 'Status', 'Due', 'Amount'].map((h) => (
                      <th key={h} className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id} className="border-b border-black/5 last:border-0 dark:border-white/10">
                      <td className="px-4 py-3 font-medium">{invoice.number}</td>
                      <td className="px-4 py-3 text-muted">{invoice.status.replace('_', ' ')}</td>
                      <td className="px-4 py-3 text-muted">
                        {invoice.due_at ? DATE.format(new Date(invoice.due_at)) : '—'}
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {MONEY(invoice.currency).format(invoice.total_minor / 100)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {outstanding > 0 ? (
              <p className="text-sm text-muted">
                Outstanding: {MONEY(invoices[0]!.currency).format(outstanding / 100)}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
