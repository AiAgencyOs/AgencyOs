import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { formatCostMinor } from '@/lib/admin/agent-eval';
import { listAllAgentRuns, type AgentRunTraceRow } from '@/lib/admin/agent-status';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { EmptyState, IconAgents, PageHeader, StatusBadge } from '@/ui';

export const metadata: Metadata = { title: 'Task Trace' };

function money(minor: number): string {
  const major = formatCostMinor(minor);
  return major ? `₹${major}` : '₹0';
}

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

/**
 * P4-ORCH-ADMINUI's Task Trace — every `ai.agent_runs` row across every
 * agent, one org-wide list. `/agents/:key` already shows one agent's own run
 * history; this is the same table unfiltered, ordered so runs sharing a
 * `correlation_id` (the chain a handoff advances, G-128) sit together —
 * closest thing to a real trace this schema can give without the
 * `routing_decisions` table #525 introduces, which this slice deliberately
 * does not depend on.
 *
 * Read-only, gated on `audit.read` like the rest of `/agents/*`.
 */
export default async function TaskTracePage() {
  const context = await requireInternal('/agents/trace');
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const runs = await listAllAgentRuns();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Task Trace"
        description={
          runs.length === 0
            ? 'No agent runs recorded yet.'
            : `${runs.length} run${runs.length === 1 ? '' : 's'}, grouped by correlation chain.`
        }
      />

      {runs.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {runs.map((r: AgentRunTraceRow) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <Link href={`/agents/${r.agentKey}`} className="font-medium underline-offset-2 hover:underline">
                    {r.agentKey}
                  </Link>
                  <StatusBadge status={r.status} />
                  <span className="text-xs text-muted">{r.trigger}</span>
                </span>
                {r.error ? <span className="text-xs text-danger">{r.error}</span> : null}
              </div>
              <span className="flex items-center gap-3 text-xs text-muted">
                <span>{r.model ?? '—'}</span>
                <span className="tabular">
                  {r.stepCount} step{r.stepCount === 1 ? '' : 's'}
                </span>
                <span className="tabular">{money(r.costMinor)}</span>
                <span>{when(clock, r.createdAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<IconAgents size={22} />} title="No runs recorded yet" />
      )}
    </div>
  );
}
