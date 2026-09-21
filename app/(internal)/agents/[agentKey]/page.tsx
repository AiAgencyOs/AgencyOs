import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { formatCostMinor, whyNotRun } from '@/lib/admin/agent-eval';
import { getAgent, listAgentRuns } from '@/lib/admin/agent-status';
import { hasConfiguredProvider } from '@/lib/ai/router';
import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Card, CardHeader, DetailList, DetailRow, EmptyState, IconAgents, PageHeader, StatusBadge } from '@/ui';

export const metadata: Metadata = { title: 'Agent' };

function money(minor: number): string {
  const major = formatCostMinor(minor);
  return major ? `₹${major}` : '₹0';
}

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

/**
 * Agent Detail — SCR-063. The registry row plus its run history, both
 * already-existing reads (aiStatus, ai.agent_runs) just never drilled into
 * from one agent. Still read-only: activation and limits are ADM-82's
 * owner-in-the-database decision, unchanged by this page.
 */
export default async function AgentDetailPage({ params }: { params: Promise<{ agentKey: string }> }) {
  const { agentKey } = await params;

  const context = await requireInternal(`/agents/${agentKey}`);
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const [agent, runs, providerConfigured] = await Promise.all([
    getAgent(agentKey),
    listAgentRuns(agentKey),
    hasConfiguredProvider(),
  ]);
  if (!agent) notFound();

  const blocked = whyNotRun(agent, providerConfigured);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={agent.displayName}
        description={agent.description ?? undefined}
        meta={
          <Badge tone={blocked ? 'neutral' : 'success'} dot>
            {blocked ? `would not run — ${blocked}` : 'would run'}
          </Badge>
        }
      />

      <Card>
        <CardHeader title="Configuration" />
        <DetailList className="px-4 sm:px-5">
          <DetailRow label="Key" value={<code className="text-xs">{agent.key}</code>} />
          <DetailRow label="Enabled" value={agent.enabled ? 'yes' : 'no'} />
          {!agent.enabled && agent.disabledReason ? <DetailRow label="Disabled reason" value={agent.disabledReason} /> : null}
          <DetailRow label="Autonomy" value={agent.autonomyLevel} />
          <DetailRow label="Default model" value={agent.defaultModel ?? '—'} />
          <DetailRow label="Default effort" value={agent.defaultEffort ?? '—'} />
          <DetailRow label="Max steps" value={agent.maxSteps ?? '—'} />
          <DetailRow label="Max cost per run" value={agent.maxCostMinor !== null ? money(agent.maxCostMinor) : '—'} />
          <DetailRow
            label="Last validated"
            value={agent.lastValidatedAt ? `${when(clock, agent.lastValidatedAt)}${agent.definitionVersion ? ` · ${agent.definitionVersion}` : ''}` : 'never'}
          />
        </DetailList>
      </Card>

      <Card>
        <CardHeader title="Recent runs" description={runs.length === 0 ? undefined : `${runs.length} most recent`} />
        {runs.length > 0 ? (
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[13px] sm:px-5">
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    <span className="text-muted">{r.trigger}</span>
                  </span>
                  {r.error ? <span className="text-xs text-danger">{r.error}</span> : null}
                </span>
                <span className="flex items-center gap-3 text-xs text-muted">
                  <span>{r.model ?? '—'}</span>
                  <span className="tabular">{r.stepCount} step{r.stepCount === 1 ? '' : 's'}</span>
                  <span className="tabular">{money(r.costMinor)}</span>
                  <span>{when(clock, r.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<IconAgents size={20} />} title="No runs recorded yet" />
        )}
      </Card>
    </div>
  );
}
