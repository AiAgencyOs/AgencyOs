import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { formatCostMinor } from '@/lib/admin/agent-eval';
import { agencyClock } from '@/lib/admin/agency-clock';
import { getAgentRunWithSteps } from '@/lib/admin/agent-runs';
import { formatDurationMs, runDurationMs, stepToolName } from '@/lib/admin/agent-runs-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  Badge,
  Card,
  CardHeader,
  DetailPanel,
  EmptyState,
  IconAgents,
  PageHeader,
  PermissionDenied,
  Stat,
  StatGrid,
  StatusBadge,
  ViewAll,
  humanize,
  type DetailField,
} from '@/ui';

export const metadata: Metadata = { title: 'Agent run' };

const N = new Intl.NumberFormat('en-IN');

/**
 * One agent run and its step trace — SCR-063/065's "step trace + tool calls".
 * The run is the `ai.agent_runs` row; the trace is its `ai.agent_steps` rows
 * in sequence, each with what the runtime wrote down: kind, tokens, cost,
 * latency when stored, and the error if that step failed. The request and
 * response bodies stay in the database — only a tool name is lifted out of
 * the request, and only when it plainly carries one. Read-only.
 */
export default async function AgentRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  const context = await requireInternal(`/usage/runs/${runId}`);
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) return <PermissionDenied />;

  const found = await getAgentRunWithSteps(runId);
  if (!found) notFound();
  const { run, steps } = found;

  const cost = (minor: number) => `₹${formatCostMinor(minor) ?? '0.00'}`;
  const duration = formatDurationMs(runDurationMs(run.startedAt, run.finishedAt));
  const stepsCost = steps.reduce((n, s) => n + s.costMinor, 0);

  const rows: DetailField[] = [
    { label: 'Run id', value: <code className="text-xs">{run.id}</code> },
    {
      label: 'Agent',
      value: (
        <Link href={`/agents/${encodeURIComponent(run.agentKey)}`} className="text-brand hover:underline">
          {run.agentKey}
        </Link>
      ),
    },
    { label: 'Status', value: <StatusBadge status={run.status} /> },
    { label: 'Trigger', value: humanize(run.trigger) },
    {
      label: 'Subject',
      value: run.subjectType ? `${humanize(run.subjectType)}${run.subjectId ? ` · ${run.subjectId}` : ''}` : '—',
    },
    { label: 'Work class', value: run.workClass ? humanize(run.workClass) : '—' },
    { label: 'Model', value: run.model ? <code className="text-xs">{run.model}</code> : '—' },
    {
      label: 'Prompt',
      value: run.promptKey ? `${run.promptKey}${run.promptVersion ? ` @ ${run.promptVersion}` : ''}` : '—',
    },
    { label: 'Correlation', value: run.correlationId ? <code className="text-xs">{run.correlationId}</code> : '—' },
    { label: 'Created', value: clock.dateTime(run.createdAt) },
    { label: 'Started', value: run.startedAt ? clock.dateTime(run.startedAt) : '—' },
    { label: 'Finished', value: run.finishedAt ? clock.dateTime(run.finishedAt) : '—' },
    { label: 'Duration', value: duration ?? '—' },
    {
      label: 'Cache tokens',
      value: run.cacheReadTokens || run.cacheWriteTokens ? `${N.format(run.cacheReadTokens)} read · ${N.format(run.cacheWriteTokens)} written` : '—',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Agent runs"
        title={`${run.agentKey} · ${humanize(run.trigger)}`}
        description={run.error ?? undefined}
        meta={<StatusBadge status={run.status} />}
        actions={<ViewAll href="/usage/runs" label="All runs" />}
      />

      <StatGrid>
        <Stat label="Steps" value={String(run.stepCount)} caption={steps.length === run.stepCount ? 'As recorded' : `${steps.length} step rows stored`} />
        <Stat label="Input tokens" value={N.format(run.inputTokens)} caption="Across the run" />
        <Stat label="Output tokens" value={N.format(run.outputTokens)} caption="Across the run" />
        <Stat label="Cost" value={cost(run.costMinor)} caption={steps.length > 0 && stepsCost !== run.costMinor ? `Steps sum to ${cost(stepsCost)}` : 'What the runtime wrote down'} tone="brand" />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(19rem,1fr)]">
        <Card>
          <CardHeader
            title="Step trace"
            description={steps.length === 0 ? undefined : `${steps.length} step${steps.length === 1 ? '' : 's'}, in sequence.`}
          />
          {steps.length === 0 ? (
            <div className="px-4 pb-4 sm:px-5">
              <EmptyState
                icon={<IconAgents size={20} />}
                title="No steps recorded for this run"
                description={
                  run.stepCount > 0
                    ? `The run reports ${run.stepCount} step${run.stepCount === 1 ? '' : 's'} but no step rows are stored — the trace was not written, or is not readable from here.`
                    : 'The runtime recorded no steps — the run may not have started, or it ended before its first step.'
                }
              />
            </div>
          ) : (
            <ol className="divide-y divide-line">
              {steps.map((s) => {
                const tool = stepToolName(s.request);
                const latency = formatDurationMs(s.latencyMs);
                return (
                  <li key={s.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 px-4 py-3 text-[13px] sm:px-5">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="tabular w-6 shrink-0 text-xs text-muted">#{s.seq}</span>
                        <span className="font-medium">{humanize(s.kind)}</span>
                        {tool ? <Badge tone="info" mono>{tool}</Badge> : null}
                        <Badge tone={s.error ? 'danger' : 'success'} dot>{s.error ? 'Failed' : 'OK'}</Badge>
                      </span>
                      {s.error ? <span className="break-words text-xs text-danger">{s.error}</span> : null}
                    </div>
                    <div className="tabular flex shrink-0 flex-wrap items-center gap-3 text-xs text-muted">
                      <span>{N.format(s.tokensIn)} in / {N.format(s.tokensOut)} out</span>
                      <span>{cost(s.costMinor)}</span>
                      <span>{latency ?? '— latency'}</span>
                      <span>{clock.dateTime(s.createdAt)}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        <DetailPanel title="Run" rows={rows} />
      </div>
    </div>
  );
}
