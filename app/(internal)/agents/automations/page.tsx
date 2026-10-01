import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listHandoffs } from '@/lib/admin/agent-status';
import { humanAction, humanEvent, workflowDefinitions } from '@/lib/admin/automation-workflows-eval';
import { readJobKindStats } from '@/lib/admin/automation-workflows';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { AGENT_KEYS } from '@/modules/agents/registry';
import { Badge, Card, CardHeader, EmptyState, IconAgents, PageHeader, StatusBadge, PermissionDenied } from '@/ui';

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
  if (!can(context, 'audit.read')) return <PermissionDenied />;

  const [handoffs, jobStats] = await Promise.all([listHandoffs(), readJobKindStats()]);
  const definitions = workflowDefinitions(AGENT_KEYS);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Automations"
        description={
          handoffs.length === 0
            ? 'Workflows are defined in code; no agent-to-agent handoff has been recorded yet.'
            : `${handoffs.length} handoff${handoffs.length === 1 ? '' : 's'}, most recent first.`
        }
      />

      {/*
        Owner decision #10 (Round 2): automation workflows stay in code. This
        lists what the code defines — each event, who reacts to it, and the job
        kind each reaction becomes — with how each kind ran in the last thirty
        days. There is nothing here to create or edit, by decision.
      */}
      <Card>
        <CardHeader
          title="Workflow Definitions"
          description={`${definitions.length} events start work, defined in the application's code (a change is a code review, not a setting). Runs are jobs of the last ${jobStats.windowDays} days${jobStats.capped ? ', from the most recent 5,000' : ''}.`}
        />
        <ul className="divide-y divide-line">
          {definitions.map((d) => (
            <li key={d.event} className="flex flex-col gap-1.5 px-4 py-3 text-[13px] sm:px-5">
              <span className="font-medium">When {humanEvent(d.event)}</span>
              <ul className="flex flex-col gap-1">
                {d.steps.map((step) => {
                  const stats = jobStats.stats.get(step.jobKind);
                  return (
                    <li key={step.handler} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        {step.actorIsAgent ? (
                          <Link href={`/agents/${step.actor}`} className="underline-offset-2 hover:underline">{step.actor}</Link>
                        ) : (
                          <span>{step.actor}</span>
                        )}
                        <Badge tone={step.actorIsAgent ? 'info' : 'neutral'}>{step.actorIsAgent ? 'agent' : 'application'}</Badge>
                        <span className="text-muted">{humanAction(step.action)}</span>
                        <code className="text-xs text-muted">{step.jobKind}</code>
                      </span>
                      <span className="text-xs text-muted">
                        {stats ? `${stats.runs} run${stats.runs === 1 ? '' : 's'}${stats.failed > 0 ? `, ${stats.failed} failed` : ''}` : 'no run in the window'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </Card>

      {handoffs.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {handoffs.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
