import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { aiStatus } from '@/lib/admin/agent-status';
import { wouldRun } from '@/lib/admin/agent-eval';
import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { Badge, Callout, IconAlert, IconClock, PageHeader, Stat, type Tone } from '@/ui';
import { can } from '@/lib/authz/permissions';
import { describeBacklog, severityOf } from '@/lib/observability/backlog';
import { viewFailedDelivery } from '@/lib/observability/delivery';
import {
  listDeadJobs,
  listFailedDeliveries,
  readBacklog,
  readCronAgeSeconds,
  readWedgedFollowUps,
} from '@/lib/observability/queries';

import { RequeueForm } from './requeue-form';

export const metadata: Metadata = { title: 'Operations' };

/**
 * What is going wrong — gaps G-053, G-058, and the open half of G-080.
 *
 * Before this, a job reached `dead` and the fact lived in a `console.error`
 * line in a Vercel log. The row said `status = 'dead'` and `last_error` said
 * why, and nothing in the product ever showed either.
 *
 * The counts say whether the system is currently coping. The dead letters say
 * what it gave up on, with the error as written — the only record of why the
 * work stopped, and what somebody needs to decide whether to requeue it by
 * hand. Two more surfaces answer questions the job backlog cannot: the failed
 * client deliveries — messages that ran to completion and the provider refused,
 * which no dead job represents — and a one-line provider/agent health strip, so
 * an operator triaging a quiet system can tell a stopped scheduler from an
 * unconfigured AI provider from a deliberately-disabled agent.
 *
 * Gated on `audit.read`, which is owner and ops_admin: this is the same class
 * of information as the audit trail, and a delivery lead has no more business
 * reading another team's failures than reading their approvals.
 *
 * **A dead job can now be requeued from here** — G-099, and the paragraph that
 * used to stand here said it could not, because reviving dead work is a write
 * with real consequences and deserved its own design rather than a button.
 * That design turned out to be mostly an argument: a dead job is one the
 * runner already attempted five times unattended, so a requeue is a sixth
 * attempt of something the queue already does on its own, and both handlers
 * were written to survive replay — `milestone.unlock` by a `status = 'pending'`
 * predicate, `requirement.extract` by a unique index on the transcript state.
 * What needed protecting was the queue's own bookkeeping, which is why
 * `core.requeue_job` refuses anything that is not dead, under a row lock, and
 * reuses the row rather than inserting one that would collide on its dedupe
 * key.
 */
export default async function OperationsPage() {
  const context = await requireInternal('/operations');
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  // Reading the failures and reviving them are different permissions, even
  // though both resolve to owner and ops_admin today. Drawing the button from
  // the capability rather than from "they got this far" keeps that true when
  // one of the two lists changes.
  const canRequeue = can(context.role, 'job.requeue');

  const [backlog, dead, cronAge, wedged, failedRows, ai] = await Promise.all([
    readBacklog(),
    listDeadJobs(),
    readCronAgeSeconds(),
    readWedgedFollowUps(),
    listFailedDeliveries(),
    aiStatus(),
  ]);

  const severity = severityOf(backlog);
  const lines = describeBacklog(backlog);

  const failed = failedRows.map(viewFailedDelivery);

  // Provider/agent health, compact: the /agents page has the detail. "Would
  // run" reuses the exact gate that page shows, so the two can never disagree.
  const agentsEnabled = ai.agents.filter((a) => a.enabled).length;
  const agentsRunnable = ai.agents.filter((a) => wouldRun(a, ai.providerConfigured)).length;

  // A tick older than the reaper's staleness window means the scheduler has
  // stopped — the failure the in-app monitoring cannot alert on itself.
  const cronStale = cronAge === null || cronAge > 15 * 60;
  const cronLabel =
    cronAge === null
      ? 'unknown'
      : cronAge > 3600
        ? `${Math.floor(cronAge / 3600)}h ago`
        : cronAge > 90
          ? `${Math.floor(cronAge / 60)}m ago`
          : `${cronAge}s ago`;

  const tone: Tone =
    severity === 'failing' ? 'danger' : severity === 'degraded' ? 'warning' : 'neutral';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Operations"
        description={
          severity === 'clear'
            ? 'Nothing is stuck.'
            : severity === 'failing'
              ? 'Work has been lost and nothing will retry it.'
              : 'Work is late but still moving.'
        }
        meta={
          <Badge tone={tone} dot>
            {severity === 'clear' ? 'Clear' : severity === 'failing' ? 'Failing' : 'Degraded'}
          </Badge>
        }
      />

      <Callout
        tone={cronStale ? 'danger' : 'info'}
        icon={<IconClock size={16} />}
        title="Scheduler"
      >
        {cronStale
          ? `no tick in ${cronLabel} — the scheduler may be stopped`
          : `last tick ${cronLabel}`}
      </Callout>

      {lines.length > 0 ? (
        <Callout tone={severity === 'failing' ? 'danger' : 'warning'} icon={<IconAlert size={16} />}>
          <ul className="flex flex-col gap-1">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {(
          [
            ['Dead jobs', backlog.dead_jobs],
            ['Stalled', backlog.stalled_jobs],
            ['Queued > 15m', backlog.stuck_queued_jobs],
            ['Unpublished', backlog.unpublished_events],
            ['Dead events', backlog.dead_events],
            ['Approvals late', backlog.overdue_approvals],
          ] as [string, number][]
        ).map(([label, count]) => (
          <Stat
            key={label}
            label={label}
            value={count}
            tone={count > 0 ? 'danger' : 'neutral'}
          />
        ))}
      </div>

      {/*
        Provider and agent health, compact — the answer to "can the AI actually
        act right now?" without leaving this page. The full registry (which
        agent, what it may do, why it is off) is on /agents; this is one line so
        an operator triaging a quiet system can tell a missing provider key from
        a deliberately-disabled agent. `wouldRun` is the SAME gate /agents shows,
        so they cannot disagree. `providerConfigured` is a boolean — never the key.
      */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-3.5 text-sm shadow-xs">
        <span className="font-semibold">AI provider &amp; agents</span>
        <span className="text-muted">
          {ai.providerConfigured ? (
            <span className="text-success">provider configured</span>
          ) : (
            <span className="text-warning">no provider configured</span>
          )}{' '}
          · {agentsEnabled} enabled · {agentsRunnable} would run ·{' '}
          <a href="/agents" className="underline hover:text-foreground">
            detail
          </a>
        </span>
      </div>

      {/*
        Wedged follow-ups — G-012. A sequence blocked on the same reason every
        tick sits active and overdue, sending nothing, while no job is dead and
        the backlog above stays clear. Shown by REASON and nothing more: a
        deployment with no timezone (G-137) wedges every due sequence on
        `timezone_unavailable` by design, so this reports the worker's own
        reason and lets a person tell that known wait from a real defect like
        `no_conversation`. Deliberately not folded into the alert severity, for
        that same reason — see core.wedged_follow_ups().
      */}
      {wedged.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Follow-ups wedged</h2>
          <p className="text-xs text-muted">
            Sequences the scheduler keeps evaluating but cannot advance, grouped by why. A{' '}
            <code>timezone_unavailable</code> row is the expected wait until an agency timezone is set
            (G-137); anything else is worth a look.
          </p>
          <ul className="flex flex-col gap-2">
            {wedged.map((w) => (
              <li
                key={w.reason}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm"
              >
                <span className="font-medium tabular">
                  {w.wedged} <span className="font-normal text-muted">{w.reason}</span>
                </span>
                {w.oldest_due_at ? (
                  <span className="text-xs text-muted">oldest due {clock.dateTime(w.oldest_due_at)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Dead letters</h2>

        {dead.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">
            No job has been given up on.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {dead.map((job) => (
              <li
                key={job.id}
                className="rounded-lg border border-line bg-surface px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{job.kind}</span>
                  <span className="text-xs text-muted">
                    {job.attempts}/{job.max_attempts} attempts · {clock.dateTime(job.updated_at)}
                  </span>
                </div>
                <p className="mt-1 break-words text-muted">
                  {job.last_error ?? 'No error was recorded, which is itself worth investigating.'}
                </p>
                {canRequeue ? <RequeueForm jobId={job.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        Failed client deliveries — a message that left the outbox and the
        provider REFUSED. A dead job is work the runner abandoned; this ran to
        completion and bounced, and nothing in the job/event backlog above shows
        it. The record already exists per-message (crm.mark_outbound_delivery
        stamps delivery:'failed' with the provider's own error); this only
        gathers them. No retry button: re-sending a bounced customer message is
        a consent-and-content decision, not a queue mechanic, so it stays a human
        act from the lead's own thread. The reason shown is the provider's,
        verbatim.
      */}
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Failed client deliveries</h2>

        {failed.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">
            No outbound message has been refused by the provider.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {failed.map((m, i) => (
              <li
                key={`${m.occurredAt}:${i}`}
                className="rounded-lg border border-red-500/20 px-4 py-3 text-sm dark:border-red-500/25"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-danger">{m.reason}</span>
                  <span className="text-xs text-muted">
                    {m.authorType} · {clock.dateTime(m.occurredAt)}
                  </span>
                </div>
                <p className="mt-1 break-words text-muted">“{m.preview}”</p>
                {m.providerRef ? (
                  <p className="mt-1 text-xs text-muted">
                    provider ref <code>{m.providerRef}</code>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        Said on the page rather than left to be discovered. The requeue button
        is new (G-099); what has not changed is that nothing brings a dead job
        back on its own, and that the alert only reaches a person where
        ALERT_WEBHOOK_URL is set. Both are true and neither is obvious.
      */}
      <p className="text-xs text-muted">
        Dead jobs are never retried on their own. Requeueing one gives it a fresh set of attempts
        and records who asked for it. Alerts reach a person only where <code>ALERT_WEBHOOK_URL</code>{' '}
        is configured; otherwise the situation is written to the log, once per situation.
      </p>
    </div>
  );
}
