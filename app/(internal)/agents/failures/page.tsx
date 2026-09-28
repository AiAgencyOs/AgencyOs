import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listFailureQueue } from '@/lib/admin/agent-status';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Card, EmptyState, IconCheck, PageHeader, StatusBadge } from '@/ui';

export const metadata: Metadata = { title: 'Failure Queue' };

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

/**
 * P4-ORCH-ADMINUI's Failure Queue — every `ai.agent_runs` row stopped
 * `failed`/`budget_exceeded` and every `ai.handoffs` row stopped
 * `rejected`/`failed_retryable`/`failed_permanent`, org-wide. Both are real
 * terminal states each table's own CHECK has always allowed
 * (`20260807120008`, `20260814120003`); this is their first combined reader.
 * Retry/fallback and budget-usage dashboards are explicitly out of this
 * slice — they need the `routing_decisions` table #525 introduces, which is
 * not merged here.
 *
 * Read-only, gated on `audit.read` like the rest of `/agents/*` — a failed
 * run is retried or abandoned by the agent runtime's own doors, never a
 * click on this page.
 */
export default async function FailureQueuePage() {
  const context = await requireInternal('/agents/failures');
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const { runs, handoffs } = await listFailureQueue();
  const total = runs.length + handoffs.length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Failure Queue"
        description={
          total === 0
            ? 'Nothing is currently stopped on a failure.'
            : `${runs.length} failed run${runs.length === 1 ? '' : 's'}, ${handoffs.length} failed handoff${handoffs.length === 1 ? '' : 's'}.`
        }
      />

      {total === 0 ? (
        <EmptyState icon={<IconCheck size={22} />} title="No failures recorded" />
      ) : (
        <>
          <Card className="p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Failed runs</h2>
            {runs.length > 0 ? (
              <ul className="mt-3 flex flex-col divide-y divide-line">
                {runs.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                    <span className="flex items-center gap-2">
                      <Link href={`/agents/${r.agentKey}`} className="font-medium underline-offset-2 hover:underline">
                        {r.agentKey}
                      </Link>
                      <StatusBadge status={r.status} />
                      {r.error ? <span className="text-danger">{r.error}</span> : null}
                    </span>
                    <span className="text-xs text-muted">{when(clock, r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-muted">No run is currently failed or over budget.</p>
            )}
          </Card>

          <Card className="p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Failed handoffs</h2>
            {handoffs.length > 0 ? (
              <ul className="mt-3 flex flex-col divide-y divide-line">
                {handoffs.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                    <span className="flex items-center gap-2">
                      <Link href={`/agents/${h.fromAgent}`} className="font-medium underline-offset-2 hover:underline">
                        {h.fromAgent}
                      </Link>
                      <span className="text-muted">→</span>
                      <Link href={`/agents/${h.toAgent}`} className="font-medium underline-offset-2 hover:underline">
                        {h.toAgent}
                      </Link>
                      <StatusBadge status={h.status} />
                    </span>
                    <span className="text-xs text-muted">{when(clock, h.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-muted">No handoff is currently rejected or failed.</p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
