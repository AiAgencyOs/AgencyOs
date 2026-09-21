import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProposedRequirements } from '@/modules/crm/queries';
import { Badge, EmptyState, IconCheck, PageHeader } from '@/ui';

export const metadata: Metadata = { title: 'Requirements' };

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

/**
 * Requirements Dashboard — SCR-028. Every requirement version still
 * awaiting a human decision, across every lead. The decision itself stays
 * on the lead's own page (requirement-decision-form.tsx, which requires
 * opening the specific lead to reach) — this is the cross-lead view of what
 * is waiting, oldest first, so an owner does not have to check every lead
 * to find the ones nobody has answered.
 */
export default async function RequirementsPage() {
  const context = await requireInternal('/requirements');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');
  const clock = await agencyClock();

  const proposed = await listProposedRequirements();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Requirements"
        description={
          proposed.length === 0
            ? 'Nothing awaiting a decision.'
            : `${proposed.length} requirement version${proposed.length === 1 ? '' : 's'} awaiting accept/reject, oldest first.`
        }
      />

      {proposed.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {proposed.map((r) => (
            <li key={r.id}>
              <Link
                href={`/leads/${r.leadId}`}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-surface-hover sm:px-5"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{r.leadTitle}</span>
                  <Badge tone="neutral">v{r.version}</Badge>
                  <Badge tone={r.source === 'agent' ? 'brand' : 'neutral'}>{r.source}</Badge>
                </span>
                <span className="text-xs text-muted">proposed {when(clock, r.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<IconCheck size={22} />}
          title="Nothing awaiting a decision"
          description="A requirement version proposed by the agent or drafted by hand appears here until an owner accepts or rejects it."
        />
      )}
    </div>
  );
}
