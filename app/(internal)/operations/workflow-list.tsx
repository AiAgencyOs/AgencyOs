'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { Workflow } from '@/lib/admin/run-chain';
import { planWorkflowCancel } from '@/lib/observability/cancel-workflow-plan';
import { Badge, Drawer, StatusBadge, buttonClass } from '@/ui';

import { EscalateControl, type EscalationView } from '../notifications/escalate-form';

import { CancelJobForm } from './cancel-job-form';
import { CancelRunningJobForm } from './cancel-running-form';
import { CancelWorkflowForm } from './cancel-workflow-form';

/**
 * Workflow runs by correlation id, with an "inspect event chain" drawer —
 * SCR-066. Everything shown was read on the server (runs, jobs); the drawer
 * only chooses which id is open. Audit entries for the chain are one click
 * further, on the audit page filtered to the same id, rather than fetched
 * for every row up front.
 */
export function WorkflowList({
  workflows,
  canCancel = false,
  canAnswerEscalation = false,
  escalations = {},
}: {
  workflows: Workflow[];
  canCancel?: boolean;
  canAnswerEscalation?: boolean;
  /** The escalation on a workflow, by `workflow-<correlation id>`, when a person raised one. */
  escalations?: Record<string, EscalationView | null>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = workflows.find((w) => w.correlationId === openId) ?? null;

  if (workflows.length === 0) {
    return <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">No correlated run has been recorded yet.</p>;
  }

  const tone = (state: Workflow['state']) => (state === 'failed' ? 'danger' : state === 'running' ? 'info' : 'success');

  return (
    <>
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {workflows.map((w) => (
          <li key={w.correlationId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge tone={tone(w.state)} dot>
                {w.state}
              </Badge>
              <code className="truncate text-xs">{w.correlationId}</code>
              <span className="text-muted">
                {w.runs.length} run{w.runs.length === 1 ? '' : 's'} · {w.jobs.length} job{w.jobs.length === 1 ? '' : 's'}
              </span>
              <span className="truncate text-xs text-muted">{[...new Set(w.runs.map((r) => r.agentKey))].join(', ')}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {w.state === 'failed' ? (
                <EscalateControl subjectType="workflow" subjectKey={`workflow-${w.correlationId}`} title={`Failed workflow ${w.correlationId.slice(0, 8)}: ${[...new Set(w.runs.map((r) => r.agentKey))].join(', ')}`} escalation={escalations[`workflow-${w.correlationId}`] ?? null} canAnswer={canAnswerEscalation} compact />
              ) : null}
              <button type="button" onClick={() => setOpenId(w.correlationId)} className={buttonClass('secondary', 'sm')}>
                Inspect chain
              </button>
            </span>
          </li>
        ))}
      </ul>

      <Drawer
        open={open !== null}
        onClose={() => setOpenId(null)}
        title="Event chain"
        description={open ? <code className="text-xs">{open.correlationId}</code> : undefined}
        footer={
          open ? (
            <Link href={`/audit?correlation=${encodeURIComponent(open.correlationId)}`} className={buttonClass('secondary', 'sm')}>
              Audit entries for this chain
            </Link>
          ) : null
        }
      >
        {open ? (
          <div className="flex flex-col gap-4 text-[13px]">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Jobs</p>
              {open.jobs.length === 0 ? (
                <p className="text-muted">No job carries this id.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {open.jobs.map((j) => (
                    <li key={j.id} className="flex flex-col gap-0.5 py-2">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{j.kind}</span>
                          <StatusBadge status={j.status} />
                        </span>
                        <span className="tabular text-xs text-muted">
                          {j.attempts}/{j.maxAttempts} attempts
                        </span>
                      </span>
                      {j.lastError ? <span className="break-words text-xs text-danger">{j.lastError}</span> : null}
                      {j.status === 'queued' || j.status === 'failed' ? <CancelJobForm jobId={j.id} compact /> : null}
                      {j.status === 'running' ? <CancelRunningJobForm jobId={j.id} compact /> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Agent runs</p>
              <ul className="divide-y divide-line">
                {open.runs.map((r) => (
                  <li key={r.id} className="flex flex-col gap-0.5 py-2">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <Link href={`/usage/runs/${r.id}`} className="font-mono text-xs underline-offset-2 hover:underline">
                          {r.id.slice(0, 8)}
                        </Link>
                        <span>{r.agentKey}</span>
                        <StatusBadge status={r.status} />
                      </span>
                      <span className="text-xs text-muted">{r.trigger}</span>
                    </span>
                    {r.error ? <span className="break-words text-xs text-danger">{r.error}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
            {canCancel ? <CancelWorkflowForm correlationId={open.correlationId} plan={planWorkflowCancel(open.jobs)} /> : null}
            {open.jobs.some((j) => j.status === 'dead') ? (
              <p className="text-xs text-muted">
                A dead job in this chain can be requeued from the Dead letters list above.
              </p>
            ) : null}
            <p className="text-xs text-muted">
              Cancelling stops a job that has not started; a running one is asked to stop and settles as cancelled at its next step. Each is audited with its reason.
            </p>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
