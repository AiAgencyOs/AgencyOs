import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { LiveRefresh } from '@/lib/realtime';
import { Card, EmptyState, IconCheck, PageHeader } from '@/ui';

import { listActionItems } from './action-items';

export const metadata: Metadata = { title: 'Notifications' };

/**
 * Notifications & Action Center — SCR-003. Every source here already has
 * its own screen and its own real data; this is the aggregation nothing
 * tied together before — an owner had to open six pages to answer "what
 * needs me right now". No new state, no snooze/dismiss mechanism: every row
 * traces to the real record on the page it links to, and resolving it there
 * is what removes it from this list. The list is live: the same tables that
 * feed it push a refresh when they change (`LiveRefresh`), and the header
 * bell's count is this list's length.
 */
export default async function NotificationsPage() {
  const context = await requireInternal('/notifications');
  const clock = await agencyClock();
  const rows = await listActionItems(context, clock);
  const urgentCount = rows.filter((r) => r.urgent).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Notifications"
        description={
          rows.length === 0
            ? 'Nothing needs your attention right now.'
            : `${rows.length} item${rows.length === 1 ? '' : 's'} need attention${urgentCount > 0 ? `, ${urgentCount} urgent` : ''}.`
        }
        actions={<LiveRefresh topics={['approvals', 'finance', 'jobs', 'qa', 'tasks', 'conversations']} />}
      />

      {rows.length > 0 ? (
        <Card>
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.key}>
                <Link
                  href={r.href}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-surface-hover sm:px-5"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className={`font-medium ${r.urgent ? 'text-danger' : 'text-foreground'}`}>
                      {r.urgent ? <span className="sr-only">Urgent: </span> : null}
                      {r.title}
                    </span>
                    <span className="text-xs text-muted">{r.detail}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState icon={<IconCheck size={22} />} title="All clear" description="No pending approvals, failed deliveries, overdue tasks or open blockers." />
      )}
    </div>
  );
}
