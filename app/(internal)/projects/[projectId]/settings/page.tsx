import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readAuditLog } from '@/lib/audit/queries';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getProject,
  listDevelopmentBreakdown,
  listPaymentPlan,
  readChangeRequests,
} from '@/modules/projects/queries';
import { Badge, Callout, Card, CardHeader, EmptyState, IconAudit, PageHeader, Stat, StatGrid } from '@/ui';

import { ProjectVisibilityForm } from '../settings-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Settings' };

/**
 * SCR-027's Settings half. Confirmed genuinely missing: `visibility` is the
 * one project-level field with a real, standing effect (the client portal's
 * RLS) and no admin control anywhere before this. Templates (the other
 * PDF ask under this screen number) stays undone — there is no project-
 * template concept anywhere in the schema, and defining what one copies
 * (tasks? milestones? modules?) is a product decision, not a code gap.
 *
 * Added: the activity-count KPI (the same three timestamped events the
 * Activity tab lists), and the audit rows whose subject IS this project —
 * `audit.audit_log` is gated to `audit.read`, so the card says so for
 * anyone who cannot see it rather than showing them an empty list. Default
 * assignees and phase notifications are not built: `projects.projects`
 * carries no such column and no notification-preference table exists.
 */
export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/settings`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const canWrite = can(context.role, 'project.write');
  const canAudit = can(context.role, 'audit.read');

  const [clock, { tasks }, milestones, changeRequests, audit] = await Promise.all([
    agencyClock(),
    listDevelopmentBreakdown(projectId),
    listPaymentPlan(projectId),
    readChangeRequests(projectId),
    canAudit ? readAuditLog({ subjectId: projectId, limit: 50 }) : Promise.resolve([]),
  ]);

  const tasksCompleted = tasks.filter((t) => t.completedAt !== null).length;
  const milestonesMet = milestones.filter((m) => m.met_at !== null).length;
  const changeRequestEvents = changeRequests.reduce((sum, cr) => sum + 1 + (cr.decidedAt ? 1 : 0), 0);
  const activityCount = tasksCompleted + milestonesMet + changeRequestEvents;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Settings`} description="Project-level configuration and its audit trail." />

      <ProjectSubNav projectId={projectId} />

      <StatGrid>
        <Stat label="Activity events" value={String(activityCount)} href={`/projects/${projectId}/activity`} />
        <Stat label="Tasks completed" value={String(tasksCompleted)} />
        <Stat label="Milestones met" value={String(milestonesMet)} />
        <Stat label="Audit rows" value={canAudit ? String(audit.length) : '—'} />
      </StatGrid>

      {canWrite ? (
        <ProjectVisibilityForm projectId={projectId} current={project.visibility} />
      ) : (
        <Callout tone="info">
          Client portal visibility is currently <strong>{project.visibility}</strong>. You do not have
          permission to change it.
        </Callout>
      )}

      <Card>
        <CardHeader
          title="Audit events for this project"
          description="Rows in the audit log whose subject is this project — status changes, visibility, conversion. Events on a task or milestone are recorded against that record, not here."
          actions={
            canAudit ? (
              <Link href="/audit" className="text-[13px] text-muted underline-offset-2 hover:underline">
                Full audit log
              </Link>
            ) : null
          }
        />
        {!canAudit ? (
          <p className="px-4 py-3 text-[13px] text-muted sm:px-5">
            The audit log is readable by owners and ops admins only.
          </p>
        ) : audit.length > 0 ? (
          <ul className="divide-y divide-line">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-medium text-foreground">{a.action}</span>
                  <Badge tone="neutral">{a.actorType}</Badge>
                  {a.hasChange ? <span className="text-xs text-muted">with before/after</span> : null}
                </span>
                <span className="text-xs text-muted">{clock.dateTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<IconAudit size={20} />} title="No audit rows yet" description="Nothing has been recorded against this project itself." />
        )}
      </Card>

      <Callout tone="info">
        Default assignees and phase notifications are not built: <code>projects.projects</code> has no
        default-assignee column and there is no notification-preference table, so there is nothing
        honest for a setting here to write to.
      </Callout>

      <Callout tone="info">
        Project templates are not built — nothing in this product defines what a template copies
        (tasks, milestones, modules), so this page does not invent one.
      </Callout>
    </div>
  );
}
