import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { formatCostMinor } from '@/lib/admin/agent-eval';
import { agencyClock } from '@/lib/admin/agency-clock';
import { getRun, listJobsByCorrelation, listRunsByCorrelation } from '@/lib/admin/run-chain';
import { readAuditLog } from '@/lib/audit/queries';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Card, CardHeader, DetailList, DetailRow, IconArrowLeft, PageHeader, StatusBadge } from '@/ui';

export const metadata: Metadata = { title: 'Agent run' };

const N = new Intl.NumberFormat('en-IN');

/**
 * One agent run and its retry / dead-letter linkage — SCR-065.
 *
 * The run row itself, then everything that shares its correlation id: the
 * jobs the queue made of this work (each attempt counted, a dead one named
 * with its last error and a link to /operations where it can be requeued),
 * the sibling runs, and the audit rows. Gated on `audit.read` like /usage;
 * RLS bounds every table to the caller's organization regardless.
 */
export default async function AgentRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const context = await requireInternal(`/usage/runs/${runId}`);
  if (!can(context.role, 'audit.read')) redirect('/dashboard');
  const clock = await agencyClock();

  const run = await getRun(runId);
  if (!run) notFound();

  const [jobs, siblings, audit] = run.correlationId
    ? await Promise.all([
        listJobsByCorrelation(run.correlationId),
        listRunsByCorrelation(run.correlationId),
        readAuditLog({ correlationId: run.correlationId, limit: 50 }),
      ])
    : [[], [], []];

  const deadJobs = jobs.filter((j) => j.status === 'dead');
  const attempts = jobs.reduce((sum, j) => sum + j.attempts, 0);
  const duration =
    run.startedAt && run.finishedAt ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000) : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Link href={`/agents/${run.agentKey}`} className="flex items-center gap-1.5 hover:text-foreground">
          <IconArrowLeft size={15} />
          {run.agentKey}
        </Link>
      </div>

      <PageHeader
        title={`Run ${run.id.slice(0, 8)}`}
        description={`${run.trigger}${run.subjectType ? ` · ${run.subjectType}${run.subjectId ? ` ${run.subjectId.slice(0, 8)}` : ''}` : ''}`}
        meta={
          <>
            <StatusBadge status={run.status} />
            {run.workClass ? <Badge tone="neutral">{run.workClass}</Badge> : null}
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Run" />
          <DetailList className="px-4 sm:px-5">
            <DetailRow label="Agent" value={<Link href={`/agents/${run.agentKey}`} className="underline-offset-2 hover:underline">{run.agentKey}</Link>} />
            <DetailRow label="Model" value={run.model ?? '—'} />
            <DetailRow label="Prompt" value={run.promptKey ? `${run.promptKey}${run.promptVersion ? ` @ ${run.promptVersion}` : ''}` : '—'} />
            <DetailRow label="Steps" value={run.stepCount} />
            <DetailRow label="Tokens" value={`${N.format(run.inputTokens)} in · ${N.format(run.outputTokens)} out`} />
            <DetailRow label="Cost" value={`₹${formatCostMinor(run.costMinor) ?? '0.00'}`} />
            <DetailRow label="Started" value={run.startedAt ? clock.dateTime(run.startedAt) : '—'} />
            <DetailRow label="Finished" value={run.finishedAt ? `${clock.dateTime(run.finishedAt)}${duration !== null ? ` · ${duration}s` : ''}` : '—'} />
            <DetailRow label="Correlation" value={run.correlationId ? <code className="text-xs">{run.correlationId}</code> : 'none — a one-off run'} />
          </DetailList>
          {run.error ? <p className="px-4 pb-4 text-[13px] text-danger sm:px-5">{run.error}</p> : null}
        </Card>

        <Card>
          <CardHeader
            title="Retries & dead letters"
            description={
              run.correlationId
                ? `${jobs.length} job${jobs.length === 1 ? '' : 's'} share this correlation id · ${attempts} attempt${attempts === 1 ? '' : 's'} in all${deadJobs.length > 0 ? ` · ${deadJobs.length} dead` : ''}`
                : 'No correlation id, so no job can be linked to this run.'
            }
            actions={
              deadJobs.length > 0 ? (
                <Link href="/operations" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
                  Requeue on Operations
                </Link>
              ) : null
            }
          />
          {jobs.length > 0 ? (
            <ul className="divide-y divide-line">
              {jobs.map((j) => (
                <li key={j.id} className="flex flex-col gap-1 px-4 py-2.5 text-[13px] sm:px-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{j.kind}</span>
                      <StatusBadge status={j.status} />
                    </span>
                    <span className="text-xs text-muted tabular">
                      {j.attempts}/{j.maxAttempts} attempts · {clock.dateTime(j.updatedAt)}
                    </span>
                  </div>
                  {j.lastError ? <p className="break-words text-xs text-danger">{j.lastError}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>

      {siblings.length > 1 ? (
        <Card>
          <CardHeader title="Runs in this workflow" description="Every run carrying the same correlation id, oldest first." />
          <ul className="divide-y divide-line">
            {siblings.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                <span className="flex items-center gap-2">
                  {s.id === run.id ? (
                    <span className="font-mono text-xs">{s.id.slice(0, 8)}</span>
                  ) : (
                    <Link href={`/usage/runs/${s.id}`} className="font-mono text-xs underline-offset-2 hover:underline">
                      {s.id.slice(0, 8)}
                    </Link>
                  )}
                  <span>{s.agentKey}</span>
                  <StatusBadge status={s.status} />
                </span>
                <span className="text-xs text-muted">{clock.dateTime(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {audit.length > 0 ? (
        <Card>
          <CardHeader title="Audit trail" description="Entries recorded under this correlation id." />
          <ul className="divide-y divide-line">
            {audit.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                <span className="flex items-center gap-2">
                  <code className="text-xs">{e.action}</code>
                  {e.subjectType ? <span className="text-muted">{e.subjectType}</span> : null}
                </span>
                <span className="text-xs text-muted">{clock.dateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
