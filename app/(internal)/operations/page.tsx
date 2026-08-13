import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { describeBacklog, severityOf } from '@/lib/observability/backlog';
import { listDeadJobs, readBacklog } from '@/lib/observability/queries';

import { RequeueForm } from './requeue-form';

export const metadata: Metadata = { title: 'Operations · AgencyOS' };

const WHEN = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * What is going wrong — gaps G-053, G-058, and the open half of G-080.
 *
 * Before this, a job reached `dead` and the fact lived in a `console.error`
 * line in a Vercel log. The row said `status = 'dead'` and `last_error` said
 * why, and nothing in the product ever showed either.
 *
 * Two things are on this page and they answer different questions. The counts
 * say whether the system is currently coping. The dead letters say what it
 * gave up on, with the error as written — that is the only record of why the
 * work stopped, and it is what somebody needs to decide whether to requeue it
 * by hand.
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
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  // Reading the failures and reviving them are different permissions, even
  // though both resolve to owner and ops_admin today. Drawing the button from
  // the capability rather than from "they got this far" keeps that true when
  // one of the two lists changes.
  const canRequeue = can(context.role, 'job.requeue');

  const [backlog, dead] = await Promise.all([readBacklog(), listDeadJobs()]);

  const severity = severityOf(backlog);
  const lines = describeBacklog(backlog);

  const tone =
    severity === 'failing'
      ? 'text-red-600 dark:text-red-400'
      : severity === 'degraded'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Operations</h1>
        <p className={`text-sm ${tone}`}>
          {severity === 'clear'
            ? 'Nothing is stuck.'
            : severity === 'failing'
              ? 'Work has been lost and nothing will retry it.'
              : 'Work is late but still moving.'}
        </p>
      </div>

      {lines.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-black/10 px-4 py-3 text-sm dark:border-white/15">
          {lines.map((line) => (
            <li key={line} className={tone}>
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ['Dead', backlog.dead_jobs],
          ['Stalled', backlog.stalled_jobs],
          ['Queued > 15m', backlog.stuck_queued_jobs],
          ['Unpublished', backlog.unpublished_events],
          ['Approvals late', backlog.overdue_approvals],
        ].map(([label, count]) => (
          <div
            key={String(label)}
            className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15"
          >
            <div className="text-lg font-semibold tabular-nums">{count}</div>
            <div className="text-xs text-muted">{label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Dead letters</h2>

        {dead.length === 0 ? (
          <p className="rounded-lg border border-black/10 px-4 py-6 text-center text-sm text-muted dark:border-white/15">
            No job has been given up on.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {dead.map((job) => (
              <li
                key={job.id}
                className="rounded-lg border border-black/10 px-4 py-3 text-sm dark:border-white/15"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{job.kind}</span>
                  <span className="text-xs text-muted">
                    {job.attempts}/{job.max_attempts} attempts · {WHEN.format(new Date(job.updated_at))}
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
