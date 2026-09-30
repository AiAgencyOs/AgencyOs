import 'server-only';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { Severity } from '@/lib/admin/escalation-types';
import type { AuthContext } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPendingApprovals } from '@/modules/approvals/queries';
import { listUnansweredClientReplies } from '@/lib/admin/client-communication';
import { listOpenAlerts } from '@/lib/observability/alerts';
import { listFailedDeliveries, listDeadJobs } from '@/lib/observability/queries';
import { listPendingPaymentClaims } from '@/modules/finance/queries';
import { listOpenDefects } from '@/modules/qa/queries';
import { listMyTasks } from '@/modules/projects/queries';
import { listWatchedPhaseChanges } from '@/modules/projects/project-defaults-queries';
import { WATCH_PHASE_LABEL } from '@/modules/projects/project-defaults-schema';

export type ActionItem = {
  key: string;
  title: string;
  detail: string;
  href: string;
  urgent: boolean;
  /**
   * SCR-003's severity chip — critical, action required, warning,
   * information — DERIVED from the source row here, never stored: an
   * overdue approval, a mismatched claim, a blocker defect or a dead job is
   * critical; a due approval, a claim to verify or an overdue task wants an
   * action; a failed delivery or a major defect is a warning; a watched
   * phase change is information. `urgent` stays: it is `severity ===
   * 'critical'` and the bell counts it.
   */
  severity: Severity;
};

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
  phase: 'Phase changes',
  reply: 'Client responses',
  alert: 'System alerts',
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
  const show = (cap: Parameters<typeof can>[1]) => can(context, cap);

  // SCR-027: phase changes on projects this person watches, from the last
  // 30 days — keyed on the change's own timestamp, so the bucket B state
  // (read / snoozed / resolved) sticks to one change and a new one is new.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [approvals, failedDeliveries, deadJobs, paymentClaims, defects, myTasks, phaseChanges, replies, alerts] = await Promise.all([
    listPendingApprovals(),
    show('audit.read') ? listFailedDeliveries() : Promise.resolve([]),
    show('job.requeue') || show('audit.read') ? listDeadJobs() : Promise.resolve([]),
    show('invoice.issue') ? listPendingPaymentClaims() : Promise.resolve([]),
    show('project.read') ? listOpenDefects() : Promise.resolve([]),
    listMyTasks(context.userId),
    show('project.read') ? listWatchedPhaseChanges(context.userId, since) : Promise.resolve([]),
    show('lead.read') ? listUnansweredClientReplies() : Promise.resolve([]),
    show('audit.read') ? listOpenAlerts(25) : Promise.resolve([]),
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
      severity: overdue ? 'critical' : 'action',
    });
  }

  for (const c of paymentClaims) {
    rows.push({
      key: `claim-${c.id}`,
      title: `Payment claim — ${c.invoiceNumber}`,
      detail: `${c.clientName ?? 'unknown client'} · claimed ${when(c.submitted_at)}`,
      href: '/invoices/verify',
      urgent: c.status === 'mismatch',
      severity: c.status === 'mismatch' ? 'critical' : 'action',
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
      severity: d.severity === 'blocker' ? 'critical' : 'warning',
    });
  }

  for (const j of deadJobs) {
    rows.push({
      key: `job-${j.id}`,
      title: `Dead job — ${j.kind}`,
      detail: j.last_error ?? 'no error recorded',
      href: '/operations',
      urgent: true,
      severity: 'critical',
    });
  }

  for (const f of failedDeliveries) {
    rows.push({
      key: `delivery-${f.occurredAt}`,
      title: 'Failed client delivery',
      detail: when(f.occurredAt),
      href: '/operations',
      urgent: false,
      severity: 'warning',
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
      severity: 'action',
    });
  }

  for (const c of phaseChanges) {
    rows.push({
      key: `phase-${c.projectId}-${c.phase}-${c.changedAt}`,
      title: `${c.projectName} — ${WATCH_PHASE_LABEL[c.phase]}: ${c.state.replace(/_/g, ' ')}`,
      detail: `changed ${when(c.changedAt)} · you watch this project`,
      href: `/projects/${c.projectId}`,
      urgent: false,
      severity: 'info',
    });
  }

  // SCR-003 "client responses": a thread whose newest message is the
  // client's. The key carries the latest message time so a new reply on a
  // resolved thread is a new row.
  for (const r of replies) {
    rows.push({
      key: `reply-${r.conversationId}-${r.latestAt}`,
      title: `Client replied${r.title ? ` — ${r.title}` : ''}`,
      detail: `${r.unread} unanswered · ${when(r.latestAt)}${r.latestBody ? ` · ${r.latestBody.slice(0, 80)}` : ''}`,
      href: r.projectId ? `/projects/${r.projectId}` : r.leadId ? `/leads/${r.leadId}` : '/communication',
      urgent: false,
      severity: 'action',
    });
  }

  // SCR-003 "system alerts": open (unacknowledged) `core.alerts`.
  for (const a of alerts) {
    rows.push({
      key: `alert-${a.id}`,
      title: a.summary,
      detail: `${a.severity} alert · seen ${a.occurrences} time${a.occurrences === 1 ? '' : 's'} · last ${when(a.lastSeenAt)}`,
      href: '/operations',
      urgent: a.severity === 'critical',
      severity: a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'info',
    });
  }

  const rank: Record<Severity, number> = { critical: 0, action: 1, warning: 2, info: 3 };
  rows.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return rows;
}
