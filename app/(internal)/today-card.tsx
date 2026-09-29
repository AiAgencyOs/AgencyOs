import Link from 'next/link';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { TodayMeeting } from '@/lib/admin/overview';
import { isAvailable, type Avail } from '@/lib/admin/overview-eval';
import type { MyTaskRow } from '@/modules/projects/queries';
import { Card, CardHeader, IconAlert, IconCheck, IconClock, IconInvoices, ViewAll } from '@/ui';

/**
 * "Today" — the card the dashboard has always carried, now shared with the
 * Sales dashboard (SCR-005, bucket F rule 1: where the PDF puts it is where
 * it goes, through the same component). Every line is a row: a meeting
 * landing today, a task of the reader's due today, the count of theirs
 * overdue, and payments waiting to be verified when the role may see money.
 * Meetings that could not be read say so rather than reading as none.
 */
export function TodayCard({
  clock,
  now,
  meetings,
  dueToday,
  overdueCount,
  paymentsToVerify,
}: {
  clock: AgencyClock;
  now: Date;
  meetings: Avail<TodayMeeting[]>;
  dueToday: readonly MyTaskRow[];
  overdueCount: number;
  /** Null when the role may not see money. */
  paymentsToVerify: number | null;
}) {
  const nothing = (!isAvailable(meetings) || meetings.value.length === 0) && dueToday.length === 0 && overdueCount === 0 && !(paymentsToVerify !== null && paymentsToVerify > 0);
  return (
    <Card>
      <CardHeader title="Today" description={clock.day(now)} actions={<ViewAll href="/my-tasks" label="My tasks" />} />
      <ul className="divide-y divide-line">
        {isAvailable(meetings) ? (
          meetings.value.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px] sm:px-5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-info-soft text-info"><IconClock size={13} /></span>
              <span className="min-w-0 flex-1 truncate text-foreground">{m.title}</span>
              <span className="shrink-0 text-xs font-medium text-muted">{m.at ? clock.clock(m.at) : 'time TBD'}</span>
            </li>
          ))
        ) : (
          <li className="px-4 py-2.5 text-[13px] text-danger sm:px-5">Meetings: DATA UNAVAILABLE</li>
        )}
        {dueToday.map((t) => (
          <li key={t.id}>
            <Link href={`/projects/${t.projectId}/board`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><IconCheck size={13} /></span>
              <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
              <span className="shrink-0 text-xs text-muted">Task due · {t.projectName}</span>
            </Link>
          </li>
        ))}
        {overdueCount > 0 ? (
          <li>
            <Link href="/my-tasks" className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger"><IconAlert size={13} /></span>
              <span className="min-w-0 flex-1 text-foreground">{overdueCount} of your task{overdueCount === 1 ? '' : 's'} overdue</span>
            </Link>
          </li>
        ) : null}
        {paymentsToVerify !== null && paymentsToVerify > 0 ? (
          <li>
            <Link href="/invoices/verify" className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning"><IconInvoices size={13} /></span>
              <span className="min-w-0 flex-1 text-foreground">{paymentsToVerify} payment{paymentsToVerify === 1 ? '' : 's'} to verify</span>
            </Link>
          </li>
        ) : null}
        {nothing ? <li className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing on the calendar, nothing of yours due, nothing to verify.</li> : null}
      </ul>
    </Card>
  );
}
