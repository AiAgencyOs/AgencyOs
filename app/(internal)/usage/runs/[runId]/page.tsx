import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { formatCostMinor } from '@/lib/admin/agent-eval';
import { agencyClock } from '@/lib/admin/agency-clock';
import { getAgentRunWithSteps } from '@/lib/admin/agent-runs';
import { listJobsByCorrelation, listRunsByCorrelation } from '@/lib/admin/run-chain';
import { formatDurationMs, runDurationMs, stepToolName } from '@/lib/admin/agent-runs-eval';
import { providerOfModel } from '@/lib/ai/model-provider';
import { mayReplay } from '@/lib/ai/replay-rules';
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

import { CancelRunningJobForm } from '../../../operations/cancel-running-form';
import { ReplayRunForm } from './replay-form';

export const metadata: Metadata = { title: 'Agent run' };

/** A recorded JSON value, rendered as it was stored — bounded so a page never chokes on a payload. */
function recorded(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
  } catch {
    return '(unrecordable)';
  }
}

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
  if (!can(context, 'audit.read')) return <PermissionDenied />;

  const found = await getAgentRunWithSteps(runId);
  if (!found) notFound();
  const { run, steps } = found;
  // SCR-065: the retries and dead letters of this piece of work — every job
  // and sibling run carrying the same correlation id.
  const [chainJobs, siblings] = run.correlationId
    ? await Promise.all([listJobsByCorrelation(run.correlationId), listRunsByCorrelation(run.correlationId)])
    : [[], []];
  const deadJobs = chainJobs.filter((j) => j.status === 'dead');
  const attempts = chainJobs.reduce((n, j) => n + j.attempts, 0);

  const cost = (minor: number) => `₹${formatCostMinor(minor) ?? '0.00'}`;
  const duration = formatDurationMs(run.latencyMs ?? runDurationMs(run.startedAt, run.finishedAt));
  // SCR-065: replay only for read-only work; cancel only while the job runs.
  const mayAct = can(context, 'job.requeue');
  const jobId = run.trigger.startsWith('job:') ? run.trigger.slice(4) : null;
  const runningJob = chainJobs.find((j) => j.id === jobId && j.status === 'running') ?? null;
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
    { label: 'Provider', value: providerOfModel(run.model) ?? '—' },
    { label: 'Project', value: run.projectId ? <Link href={`/projects/${run.projectId}`} className="text-brand hover:underline">{run.projectId.slice(0, 8)}</Link> : '—' },
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
        actions={
          <span className="flex flex-wrap items-center gap-2">
            {mayAct && mayReplay(run.workClass) ? <ReplayRunForm runId={run.id} /> : null}
            {mayAct && runningJob ? <CancelRunningJobForm jobId={runningJob.id} compact /> : null}
            <ViewAll href="/usage/runs" label="All runs" />
          </span>
        }
      />
      {mayAct && !mayReplay(run.workClass) ? (
        <p className="text-xs text-muted">
          Replay is offered only for read-only work (work class <code>read</code>); this run is {run.workClass ? humanize(run.workClass) : 'of no recorded class'}, and running it again would act twice.
        </p>
      ) : null}

      <StatGrid>
        <Stat label="Steps" value={String(run.stepCount)} caption={steps.length === run.stepCount ? 'As recorded' : `${steps.length} step rows stored`} />
        <Stat label="Input tokens" value={N.format(run.inputTokens)} caption="Across the run" />
        <Stat label="Output tokens" value={N.format(run.outputTokens)} caption="Across the run" />
        <Stat label="Cost" value={cost(run.costMinor)} caption={steps.length > 0 && stepsCost !== run.costMinor ? `Steps sum to ${cost(stepsCost)}` : 'What the runtime wrote down'} tone="brand" />
      </StatGrid>

      <Card>
        <CardHeader
          title="Retries & dead letters"
          description={
            run.correlationId
              ? `${chainJobs.length} job${chainJobs.length === 1 ? '' : 's'} share this correlation id · ${attempts} attempt${attempts === 1 ? '' : 's'} in all${deadJobs.length > 0 ? ` · ${deadJobs.length} dead` : ''}${siblings.length > 1 ? ` · ${siblings.length} runs` : ''}`
              : 'No correlation id, so no job or sibling run can be linked to this one.'
          }
          actions={deadJobs.length > 0 ? <ViewAll href="/operations" label="Requeue on Operations" /> : <ViewAll href="/operations" label="Operations" />}
        />
        {chainJobs.length > 0 ? (
          <ul className="divide-y divide-line">
            {chainJobs.map((j) => (
              <li key={j.id} className="flex flex-col gap-1 px-4 py-2.5 text-[13px] sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{j.kind}</span>
                    <StatusBadge status={j.status} />
                  </span>
                  <span className="tabular text-xs text-muted">{j.attempts}/{j.maxAttempts} attempts · {clock.dateTime(j.updatedAt)}</span>
                </div>
                {j.lastError ? <p className="break-words text-xs text-danger">{j.lastError}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {siblings.length > 1 ? (
          <ul className="divide-y divide-line border-t border-line">
            {siblings.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
                <span className="flex items-center gap-2">
                  {s.id === run.id ? (
                    <span className="font-mono text-xs">{s.id.slice(0, 8)}</span>
                  ) : (
                    <Link href={`/usage/runs/${s.id}`} className="font-mono text-xs underline-offset-2 hover:underline">{s.id.slice(0, 8)}</Link>
                  )}
                  <span>{s.agentKey}</span>
                  <StatusBadge status={s.status} />
                </span>
                <span className="text-xs text-muted">{clock.dateTime(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

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
                      {/* SCR-065: a tool call's arguments and result, as recorded. */}
                      {s.kind === 'tool_call' ? (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted">Arguments &amp; result</summary>
                          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-sunken p-2 font-mono text-[11px]">{recorded((s.request as { input?: unknown } | null)?.input) || '(no arguments recorded)'}</pre>
                          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-sunken p-2 font-mono text-[11px]">{recorded((s.response as { result?: unknown } | null)?.result) || (s.error ? `(failed: ${s.error})` : '(no result recorded)')}</pre>
                        </details>
                      ) : null}
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
