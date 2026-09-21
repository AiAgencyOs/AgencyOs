import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPendingApprovals } from '@/modules/approvals/queries';
import { listFailedDeliveries, listDeadJobs } from '@/lib/observability/queries';
import { listPendingPaymentClaims } from '@/modules/finance/queries';
import { listOpenDefects } from '@/modules/qa/queries';
import { listMyTasks } from '@/modules/projects/queries';
import { Card, EmptyState, IconCheck, PageHeader } from '@/ui';

export const metadata: Metadata = { title: 'Notifications' };

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

type Row = { key: string; title: string; detail: string; href: string; urgent: boolean };

/**
 * Notifications & Action Center — SCR-003. Every source here already has
 * its own screen and its own real data; this is the aggregation nothing
 * tied together before — an owner had to open six pages to answer "what
 * needs me right now". No new state, no snooze/dismiss mechanism: every row
 * traces to the real record on the page it links to, and resolving it there
 * is what removes it from this list on the next load.
 */
export default async function NotificationsPage() {
  const context = await requireInternal('/notifications');
  const clock = await agencyClock();

  const show = (cap: Parameters<typeof can>[1]) => can(context.role, cap);

  const [approvals, failedDeliveries, deadJobs, paymentClaims, defects, myTasks] = await Promise.all([
    listPendingApprovals(),
    show('audit.read') ? listFailedDeliveries() : Promise.resolve([]),
    show('job.requeue') || show('audit.read') ? listDeadJobs() : Promise.resolve([]),
    show('invoice.issue') ? listPendingPaymentClaims() : Promise.resolve([]),
    show('project.read') ? listOpenDefects() : Promise.resolve([]),
    listMyTasks(context.userId),
  ]);

  const now = Date.now();
  const rows: Row[] = [];

  for (const a of approvals) {
    const overdue = a.sla_due_at ? new Date(a.sla_due_at).getTime() <= now : false;
    rows.push({
      key: `approval-${a.id}`,
      title: a.summary ?? `${a.subject_type} approval`,
      detail: overdue ? `overdue since ${when(clock, a.sla_due_at!)}` : a.sla_due_at ? `due ${when(clock, a.sla_due_at)}` : 'no deadline set',
      href: '/approvals',
      urgent: overdue,
    });
  }

  for (const c of paymentClaims) {
    rows.push({
      key: `claim-${c.id}`,
      title: `Payment claim — ${c.invoiceNumber}`,
      detail: `${c.clientName ?? 'unknown client'} · claimed ${when(clock, c.submitted_at)}`,
      href: '/invoices/verify',
      urgent: c.status === 'mismatch',
    });
  }

  const blockers = defects.filter((d) => d.severity === 'blocker' || d.severity === 'major');
  for (const d of blockers) {
    rows.push({
      key: `defect-${d.id}`,
      title: d.title,
      detail: `${d.severity} · ${d.projectName}`,
      href: '/qa',
      urgent: d.severity === 'blocker',
    });
  }

  for (const j of deadJobs) {
    rows.push({
      key: `job-${j.id}`,
      title: `Dead job — ${j.kind}`,
      detail: j.last_error ?? 'no error recorded',
      href: '/operations',
      urgent: true,
    });
  }

  for (const f of failedDeliveries) {
    rows.push({
      key: `delivery-${f.occurredAt}`,
      title: 'Failed client delivery',
      detail: when(clock, f.occurredAt),
      href: '/operations',
      urgent: false,
    });
  }

  const overdueTasks = myTasks.filter((t) => t.dueOn && t.dueOn < clock.dayKey(new Date()));
  for (const t of overdueTasks) {
    rows.push({
      key: `task-${t.id}`,
      title: t.title,
      detail: `${t.projectName} · overdue — ${clock.date(t.dueOn!)}`,
      href: '/my-tasks',
      urgent: true,
    });
  }

  rows.sort((a, b) => Number(b.urgent) - Number(a.urgent));
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
                    <span className={`font-medium ${r.urgent ? 'text-danger' : 'text-foreground'}`}>{r.title}</span>
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
