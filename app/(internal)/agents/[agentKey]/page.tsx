import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import Link from 'next/link';

import { formatCostMinor, whyNotRun } from '@/lib/admin/agent-eval';
import { listAgentFailures, listAgentPromptVersions } from '@/lib/admin/agent-metrics';
import { getAgent, listAgentRuns } from '@/lib/admin/agent-status';
import { hasConfiguredProvider } from '@/lib/ai/router';
import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Card, CardHeader, DetailList, DetailRow, EmptyState, IconAgents, PageHeader, StatusBadge, PermissionDenied } from '@/ui';

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
  if (!can(context.role, 'audit.read')) return <PermissionDenied />;

  const [agent, runs, providerConfigured] = await Promise.all([
    getAgent(agentKey),
    listAgentRuns(agentKey),
    hasConfiguredProvider(),
  ]);
  if (!agent) notFound();
  // SCR-063: the failures on their own, the prompt versions the runs
  // actually carried, and the guardrails as the registry states them.
  const [failures, promptVersions] = await Promise.all([listAgentFailures(agentKey), listAgentPromptVersions(agentKey)]);

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
          <DetailRow label="Configuration version" value={agent.definitionVersion ? <code className="text-xs">{agent.definitionVersion}</code> : 'never stamped'} />
          <DetailRow label="Last validated" value={agent.lastValidatedAt ? when(clock, agent.lastValidatedAt) : 'never'} />
        </DetailList>
      </Card>

      <Card>
        <CardHeader title="Guardrails" description="What this agent may and may not do, as the registry states it. The ceilings above are enforced by the runtime per run." />
        <div className="px-4 pb-4 text-[13px] leading-relaxed sm:px-5">
          {agent.description ? <p className="whitespace-pre-line">{agent.description}</p> : <p className="text-muted">The registry holds no description for this agent.</p>}
          <p className="mt-3 text-xs text-muted">
            Autonomy <span className="text-foreground">{agent.autonomyLevel}</span> · at most{' '}
            <span className="text-foreground">{agent.maxSteps ?? '—'}</span> steps and{' '}
            <span className="text-foreground">{agent.maxCostMinor !== null ? money(agent.maxCostMinor) : '—'}</span> per run. Tool permissions and project
            assignments have no record yet and are not shown.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Prompt versions" description="The prompt each run was stamped with — a change is visible as the version the runs carry, not as a claim." />
        {promptVersions.length > 0 ? (
          <ul className="divide-y divide-line">
            {promptVersions.map((p) => (
              <li key={`${p.promptKey}@${p.promptVersion}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                <span className="flex items-center gap-2">
                  <code className="text-xs">{p.promptKey ?? 'unnamed prompt'}</code>
                  <Badge tone="neutral" mono>{p.promptVersion ?? 'unversioned'}</Badge>
                </span>
                <span className="tabular text-xs text-muted">{p.runs} run{p.runs === 1 ? '' : 's'} · last {when(clock, p.lastUsedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No run has been recorded, so no prompt version has been stamped.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Failures" description={failures.length === 0 ? 'No failed run recorded.' : `${failures.length} most recent failed run${failures.length === 1 ? '' : 's'}, the error as the runtime wrote it.`} />
        {failures.length > 0 ? (
          <ul className="divide-y divide-line">
            {failures.map((f) => (
              <li key={f.id} className="flex flex-col gap-1 px-4 py-3 text-[13px] sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Link href={`/usage/runs/${f.id}`} className="font-mono text-xs underline-offset-2 hover:underline">{f.id.slice(0, 8)}</Link>
                    <span className="text-muted">{f.trigger}</span>
                    {f.subjectType ? <span className="text-xs text-muted">{f.subjectType} {f.subjectId ? f.subjectId.slice(0, 8) : ''}</span> : null}
                  </span>
                  <span className="text-xs text-muted">{f.model ?? '—'}{f.promptVersion ? ` · prompt ${f.promptVersion}` : ''} · {when(clock, f.createdAt)}</span>
                </div>
                <p className="break-words text-danger">{f.error ?? 'No error was recorded, which is itself worth investigating.'}</p>
              </li>
            ))}
          </ul>
        ) : null}
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
