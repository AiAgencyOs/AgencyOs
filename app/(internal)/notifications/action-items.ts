import 'server-only';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { AuthContext } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPendingApprovals } from '@/modules/approvals/queries';
import { listFailedDeliveries, listDeadJobs } from '@/lib/observability/queries';
import { listPendingPaymentClaims } from '@/modules/finance/queries';
import { listOpenDefects } from '@/modules/qa/queries';
import { listMyTasks } from '@/modules/projects/queries';

export type ActionItem = { key: string; title: string; detail: string; href: string; urgent: boolean };

/** The source a row came from, read off its key — the notification's category. */
export function categoryOf(item: ActionItem): string {
  return item.key.split('-')[0] ?? 'other';
}

export const ACTION_CATEGORY_LABEL: Record<string, string> = {
  approval: 'Approvals',
  claim: 'Payments',
  defect: 'Defects',
  job: 'Jobs',
  delivery: 'Deliveries',
  task: 'Tasks',
};

/**
 * Everything that needs a person, from the six sources that each already
 * have a screen — SCR-003's single inbox. Lives beside the page rather than
 * in `src/lib/admin` because `lib/` may not depend on `modules/`
 * (ARCHITECTURE.md §3.2), and this is exactly a composition of module reads.
 *
 * The same list feeds the page and the header bell's count, so the number a
 * person sees before opening the inbox is the number of rows inside it.
 */
export async function listActionItems(context: AuthContext, clock: AgencyClock): Promise<ActionItem[]> {
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
  const when = (value: string) => clock.dateTime(value);
  const rows: ActionItem[] = [];

  for (const a of approvals) {
    const overdue = a.sla_due_at ? new Date(a.sla_due_at).getTime() <= now : false;
    rows.push({
      key: `approval-${a.id}`,
      title: a.summary ?? `${a.subject_type} approval`,
      detail: overdue
        ? `overdue since ${when(a.sla_due_at!)}`
        : a.sla_due_at
          ? `due ${when(a.sla_due_at)}`
          : 'no deadline set',
      href: `/approvals/${a.id}`,
      urgent: overdue,
    });
  }

  for (const c of paymentClaims) {
    rows.push({
      key: `claim-${c.id}`,
      title: `Payment claim — ${c.invoiceNumber}`,
      detail: `${c.clientName ?? 'unknown client'} · claimed ${when(c.submitted_at)}`,
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
      detail: when(f.occurredAt),
      href: '/operations',
      urgent: false,
    });
  }

  const today = clock.dayKey(new Date());
  const overdueTasks = myTasks.filter((t) => t.dueOn && t.dueOn < today);
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
  return rows;
}
