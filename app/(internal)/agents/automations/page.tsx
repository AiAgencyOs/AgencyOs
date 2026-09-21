import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listHandoffs } from '@/lib/admin/agent-status';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { EmptyState, IconAgents, PageHeader, StatusBadge } from '@/ui';

export const metadata: Metadata = { title: 'Automations' };

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

/**
 * Automations — SCR-065's other half. Agent Detail (`/agents/:key`) shows
 * one agent's own runs; this is the handoff chain BETWEEN agents —
 * `ai.handoffs`, real schema and real writers (sales/service.ts, the
 * orchestrator) since mid-August, with no reader anywhere until now.
 * Read-only: a handoff moves by the agent runtime's own doors, not by an
 * Admin editing a row here.
 */
export default async function AutomationsPage() {
  const context = await requireInternal('/agents/automations');
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const handoffs = await listHandoffs();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Automations"
        description={
          handoffs.length === 0
            ? 'No agent-to-agent handoffs recorded yet.'
            : `${handoffs.length} handoff${handoffs.length === 1 ? '' : 's'}, most recent first.`
        }
      />

      {handoffs.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {handoffs.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <Link href={`/agents/${h.fromAgent}`} className="font-medium underline-offset-2 hover:underline">
                    {h.fromAgent}
                  </Link>
                  <span className="text-muted">→</span>
                  <Link href={`/agents/${h.toAgent}`} className="font-medium underline-offset-2 hover:underline">
                    {h.toAgent}
                  </Link>
                  <StatusBadge status={h.status} />
                  {h.depth > 0 ? <span className="text-xs text-muted">depth {h.depth}</span> : null}
                </span>
                <span className="text-xs text-muted">{h.objective}</span>
              </div>
              <span className="text-xs text-muted">
                {when(clock, h.createdAt)}
                {h.completedAt ? ` · completed ${when(clock, h.completedAt)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<IconAgents size={22} />}
          title="No handoffs yet"
          description="An agent handing work to another agent — a deal handed from sales to delivery, for example — will appear here."
        />
      )}
    </div>
  );
}
