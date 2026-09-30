import Link from 'next/link';

import { OUTBOX_STATUSES, type OutboxPage } from '@/lib/observability/queries';
import { Badge, buttonClass, selectClass } from '@/ui';

import { EscalateControl, type EscalationView } from '../notifications/escalate-form';

/**
 * The outbox rows — D17, reversed by the owner on 2026-09-29. Read-only: a
 * status filter (GET form, so the URL is the state) and a page at a time.
 * There is no retry control because the database has no retry door for an
 * outbox row — `core.requeue_job` revives a JOB, and nothing revives an
 * event the dispatcher parked dead. The panel says so rather than showing a
 * button that would do nothing. Everything shown is the row's own columns;
 * `status` is derived from `published_at` / `dead_at` because the table has
 * no status column, and the table has no `last_error` or `next_attempt_at`
 * to show.
 */
export function OutboxList({
  page,
  dateTime,
  canAnswerEscalation = false,
  escalations = {},
}: {
  page: OutboxPage;
  dateTime: (iso: string) => string;
  canAnswerEscalation?: boolean;
  /** The escalation on a parked-dead event, by `outbox-<id>`, when a person raised one. */
  escalations?: Record<string, EscalationView | null>;
}) {
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const href = (n: number) => `/operations?outbox=${page.status}&outboxPage=${n}#outbox`;

  return (
    <div className="flex flex-col gap-2" id="outbox">
      <form method="get" action="/operations#outbox" className="flex flex-wrap items-center gap-2 text-xs">
        <label className="text-muted" htmlFor="outbox-status">
          Show
        </label>
        <select id="outbox-status" name="outbox" defaultValue={page.status} className={selectClass}>
          {OUTBOX_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass('secondary', 'sm')}>
          Filter
        </button>
        <span className="text-muted">
          {page.total} {page.total === 1 ? 'row' : 'rows'} · page {page.page} of {pages}
        </span>
      </form>

      {page.rows.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">
          {page.status === 'all' ? 'The outbox is empty.' : `No ${page.status} events.`}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {page.rows.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2 text-[13px]">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted">#{e.id}</span>
                <span className="font-mono text-xs">{e.kind}</span>
                <Badge tone={e.status === 'dead' ? 'danger' : e.status === 'published' ? 'success' : 'warning'}>{e.status}</Badge>
                <span className="text-xs text-muted">
                  {e.attempts} {e.attempts === 1 ? 'attempt' : 'attempts'}
                </span>
              </span>
              <span className="text-xs text-muted">
                created {dateTime(e.createdAt)}
                {e.publishedAt ? ` · published ${dateTime(e.publishedAt)}` : ''}
                {e.deadAt ? ` · parked dead ${dateTime(e.deadAt)}` : ''}
              </span>
              <span className="w-full text-xs text-muted">
                {e.subjectType ? (
                  <>
                    {e.subjectType} <code>{e.subjectId ?? '—'}</code>
                  </>
                ) : (
                  'no subject'
                )}
                {' · correlation '}
                {e.correlationId ? (
                  <Link href={`/audit?correlation=${encodeURIComponent(e.correlationId)}`} className="underline-offset-2 hover:underline">
                    <code>{e.correlationId}</code>
                  </Link>
                ) : (
                  <span>none</span>
                )}
              </span>
              {/* SCR-066: an event the dispatcher parked dead has no retry door; a person can hand it to the owner. */}
              {e.status === 'dead' ? (
                <span className="w-full">
                  <EscalateControl subjectType="outbox" subjectKey={`outbox-${e.id}`} title={`Dead event #${e.id} ${e.kind}`} escalation={escalations[`outbox-${e.id}`] ?? null} canAnswer={canAnswerEscalation} compact />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {pages > 1 ? (
        <div className="flex items-center gap-3 text-xs">
          {page.page > 1 ? (
            <Link href={href(page.page - 1)} className="underline-offset-2 hover:underline">
              ← newer
            </Link>
          ) : (
            <span className="text-muted">← newer</span>
          )}
          {page.page < pages ? (
            <Link href={href(page.page + 1)} className="underline-offset-2 hover:underline">
              older →
            </Link>
          ) : (
            <span className="text-muted">older →</span>
          )}
        </div>
      ) : null}

      <p className="text-xs text-muted">
        Read-only. No retry exists for an outbox row: the dispatcher retries a live event on every pass, and an
        event it parked dead has no door in the database that brings it back — the table records no error text
        and no next-attempt time, so none is shown here.
      </p>
    </div>
  );
}
