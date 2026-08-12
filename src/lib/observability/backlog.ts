/**
 * What the system believes is wrong, and whether that is worth waking someone.
 *
 * Gap G-053. Pure and dependency-free, like `jobs/staleness.ts` and
 * `events/catalog.ts` — the decision is worth testing directly, and the thing
 * that executes it needs a service-role client a test has no business holding.
 *
 * Nothing here invents a threshold. Every count `core.operational_backlog()`
 * returns is already a failure the system declared: a job it marked `dead`, a
 * lock older than the staleness constant, an approval past the deadline its own
 * policy set. The only judgement in this file is *how loudly* to say so, and
 * that is stated as severity rather than smuggled in as a number.
 */

/** One row of `core.operational_backlog()`, as PostgREST returns it. */
export type BacklogRow = {
  dead_jobs: number;
  stalled_jobs: number;
  stuck_queued_jobs: number;
  unpublished_events: number;
  overdue_approvals: number;
  oldest_dead_at: string | null;
  oldest_unpublished_at: string | null;
  oldest_overdue_due_at: string | null;
};

export type BacklogSeverity = 'clear' | 'degraded' | 'failing';

/**
 * How bad it is.
 *
 * **failing** — work has been lost or money is stuck. A `dead` job is the
 * system's own word for "this will never be retried, and nothing is coming";
 * a milestone unlock among them means a client has paid and the next stage
 * never opened. An unpublished event is a state change nobody acted on.
 *
 * **degraded** — work is late but still moving. A stalled job will be reaped;
 * a stuck queue means the runner is behind; an overdue approval means a person
 * has not answered, which is a person problem rather than a system one.
 *
 * The split is deliberate and is the only judgement call in this file: a `dead`
 * job is worth an interruption and a slow queue is not, or the alert becomes
 * noise and the next real one is ignored.
 */
export function severityOf(backlog: BacklogRow): BacklogSeverity {
  if (backlog.dead_jobs > 0 || backlog.unpublished_events > 0) return 'failing';
  if (backlog.stalled_jobs > 0 || backlog.stuck_queued_jobs > 0 || backlog.overdue_approvals > 0) {
    return 'degraded';
  }
  return 'clear';
}

export function isHealthy(backlog: BacklogRow): boolean {
  return severityOf(backlog) === 'clear';
}

/**
 * A fingerprint of the situation.
 *
 * Counts only, never timestamps: `oldest_dead_at` moves as rows come and go
 * and would make every tick look like a new problem, which is precisely the
 * flapping the cooldown exists to prevent. Two ticks with the same counts are
 * the same situation and get one message.
 */
export function signatureOf(backlog: BacklogRow): string {
  return [
    severityOf(backlog),
    backlog.dead_jobs,
    backlog.stalled_jobs,
    backlog.stuck_queued_jobs,
    backlog.unpublished_events,
    backlog.overdue_approvals,
  ].join(':');
}

/** The lines a human reads first. Ordered worst-first, not by column order. */
export function describeBacklog(backlog: BacklogRow): string[] {
  const lines: string[] = [];

  if (backlog.dead_jobs > 0) {
    lines.push(
      `${backlog.dead_jobs} job(s) dead — nothing will retry them${
        backlog.oldest_dead_at ? `, oldest since ${backlog.oldest_dead_at}` : ''
      }`,
    );
  }
  if (backlog.unpublished_events > 0) {
    lines.push(
      `${backlog.unpublished_events} event(s) unpublished for over 15 minutes${
        backlog.oldest_unpublished_at ? `, oldest since ${backlog.oldest_unpublished_at}` : ''
      }`,
    );
  }
  if (backlog.stalled_jobs > 0) {
    lines.push(`${backlog.stalled_jobs} job(s) stalled in running — the reaper should release them`);
  }
  if (backlog.stuck_queued_jobs > 0) {
    lines.push(`${backlog.stuck_queued_jobs} job(s) queued for over 15 minutes — the runner is behind`);
  }
  if (backlog.overdue_approvals > 0) {
    lines.push(
      `${backlog.overdue_approvals} approval(s) past their deadline${
        backlog.oldest_overdue_due_at ? `, oldest due ${backlog.oldest_overdue_due_at}` : ''
      }`,
    );
  }

  return lines;
}

/** The alert body. Plain JSON, so any webhook receiver can read it. */
export function alertPayload(backlog: BacklogRow, deployment: string) {
  return {
    source: 'agencyos',
    deployment,
    severity: severityOf(backlog),
    signature: signatureOf(backlog),
    summary: describeBacklog(backlog).join('; '),
    detail: backlog,
  };
}
