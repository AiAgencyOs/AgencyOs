import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listLeads } from '@/modules/crm/queries';

export const metadata: Metadata = { title: 'Leads · AgencyOS' };

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Lead pipeline.
 *
 * The nav in the internal layout hides this entry for roles without
 * `lead.read`, but hiding a link is not access control — a contractor can
 * still type the URL. The capability is therefore re-checked here, and RLS
 * independently refuses the rows underneath, so a mistake in either layer
 * still fails closed.
 */
export default async function LeadsPage() {
  const context = await requireInternal('/leads');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const leads = await listLeads();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Leads</h1>
        <p className="text-sm text-muted">
          {leads.length === 0
            ? 'No leads yet.'
            : `${leads.length} lead${leads.length === 1 ? '' : 's'} in the pipeline.`}
        </p>
      </div>

      {leads.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
          <table className="w-full min-w-[46rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left dark:border-white/15">
                {['Lead', 'Contact', 'Status', 'Score', 'Source', 'Created'].map((h) => (
                  <th key={h} className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  className="border-b border-black/5 last:border-0 dark:border-white/10"
                >
                  <td className="px-4 py-3 font-medium">{lead.title}</td>
                  <td className="px-4 py-3 text-muted">
                    {lead.contact ? (
                      <>
                        {lead.contact.fullName}
                        {lead.contact.company ? (
                          <span className="text-xs"> · {lead.contact.company}</span>
                        ) : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
                      {lead.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{lead.score ?? '—'}</td>
                  <td className="px-4 py-3 text-muted">{lead.source}</td>
                  <td className="px-4 py-3 text-muted">
                    {DATE.format(new Date(lead.created_at))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-black/15 px-4 py-8 text-center text-sm text-muted dark:border-white/20">
          Leads captured from WhatsApp, referrals, and the website will appear here.
        </p>
      )}
    </div>
  );
}
