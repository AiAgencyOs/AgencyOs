import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readAuditLog } from '@/lib/audit/queries';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listInternalRoster, listPaymentPlan, readChangeRequests } from '@/modules/projects/queries';
import { readProjectDefaults } from '@/modules/projects/project-defaults-queries';
import { Badge, Callout, Card, CardHeader, EmptyState, IconAudit, PageHeader, PermissionDenied, Stat, StatGrid, StatusBadge } from '@/ui';

import { ProjectDetailsForm, ProjectVisibilityForm } from '../settings-panel';
import { DefaultAssigneeForm, WatchersPanel } from './project-defaults-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Settings' };

/**
 * SCR-027's Settings half. Confirmed genuinely missing: `visibility` is the
 * one project-level field with a real, standing effect (the client portal's
 * RLS) and no admin control anywhere before this. Templates (the other
 * PDF ask under this screen number) stays undone — there is no project-
 * template concept anywhere in the schema, and defining what one copies
 * (tasks? milestones? modules?) is a product decision, not a code gap.
 */
export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/settings`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const canWrite = can(context, 'project.write');
  const canAudit = can(context, 'audit.read');

  // SCR-027: the activity-count KPI (the same three timestamped events the
  // Activity tab lists) and the audit rows whose subject IS this project.
  // `audit.audit_log` is gated to `audit.read`, so the card says so for
  // anyone who cannot see it rather than showing them an empty list.
  const [clock, { tasks }, milestones, changeRequests, audit, defaults, roster] = await Promise.all([
    agencyClock(),
    listDevelopmentBreakdown(projectId),
    listPaymentPlan(projectId),
    readChangeRequests(projectId),
    canAudit ? readAuditLog({ subjectId: projectId, limit: 50 }) : Promise.resolve([]),
    readProjectDefaults(projectId),
    listInternalRoster(),
  ]);
  const members = roster.map((m) => ({ userId: m.userId, fullName: m.fullName }));
  // SCR-027: adding or removing another person's watch is owner / ops_admin
  // (project.sign_off's two roles), which `project_watchers_write` mirrors.
  const mayManageWatchers = can(context, 'project.sign_off');
  const tasksCompleted = tasks.filter((t) => t.completedAt !== null).length;
  const milestonesMet = milestones.filter((m) => m.met_at !== null).length;
  const changeRequestEvents = changeRequests.reduce((sum, cr) => sum + 1 + (cr.decidedAt ? 1 : 0), 0);
  const activityCount = tasksCompleted + milestonesMet + changeRequestEvents;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Settings`} description="Project-level configuration and its audit trail." />

      <ProjectSubNav projectId={projectId} />

      <StatGrid>
        <Stat label="Activity events" value={String(activityCount)} caption="Tasks, milestones, change requests" href={`/projects/${projectId}/activity`} />
        <Stat label="Tasks completed" value={String(tasksCompleted)} />
        <Stat label="Milestones met" value={String(milestonesMet)} />
        <Stat label="Audit rows" value={canAudit ? String(audit.length) : '—'} caption={canAudit ? 'Subject: this project' : 'Owner / ops admin only'} />
      </StatGrid>

      {/* SCR-018: the status, and why it was last set — the reason a pause or
          cancellation carried, kept where the project's configuration lives. */}
      <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
        <h2 className="text-sm font-semibold tracking-tight">Status</h2>
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          <StatusBadge status={project.status} />
          {project.status_changed_at ? <span className="text-muted">since {clock.dateTime(project.status_changed_at)}</span> : null}
        </p>
        {project.status_reason ? (
          <p className="whitespace-pre-wrap text-[13px]">
            <span className="text-muted">Reason: </span>
            {project.status_reason}
          </p>
        ) : (
          <p className="text-[13px] text-muted">No reason recorded with the current status.</p>
        )}
        <p className="text-xs text-muted">
          Status is changed on the <Link href={`/projects/${projectId}`} className="underline underline-offset-2">Overview</Link>; a move to on hold or cancelled requires a reason.
        </p>
      </section>

      {canWrite ? (
        <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
          <h2 className="text-sm font-semibold tracking-tight">Project details</h2>
          <p className="text-[13px] text-muted">The name, description, dates and budget the header and the projects list print. Status is changed on the Overview; billing on its own section.</p>
          <ProjectDetailsForm
            projectId={projectId}
            name={project.name}
            description={project.description}
            startsOn={project.starts_on}
            endsOn={project.ends_on}
            budgetMinor={project.budget_minor}
            currency={project.currency}
          />
        </section>
      ) : null}

      {canWrite ? (
        <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
          <h2 className="text-sm font-semibold tracking-tight">Client portal visibility</h2>
          <ProjectVisibilityForm projectId={projectId} current={project.visibility} />
        </section>
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
          actions={canAudit ? <Link href="/audit?subject=project" className="text-[13px] text-muted underline-offset-2 hover:underline">Full audit log</Link> : null}
        />
        {!canAudit ? (
          <p className="px-4 py-3 text-[13px] text-muted sm:px-5">The audit log is readable by owners and ops admins only.</p>
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

      {/* SCR-027: the default assignee a new task goes to, and who hears
          about phase changes (projects.default_assignee_id, project_watchers). */}
      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
        <h2 className="text-sm font-semibold tracking-tight">Default assignee</h2>
        {canWrite ? (
          <DefaultAssigneeForm projectId={projectId} current={defaults.defaultAssigneeId} roster={members} />
        ) : (
          <p className="text-[13px] text-muted">
            {defaults.defaultAssigneeId
              ? `New tasks go to ${members.find((m) => m.userId === defaults.defaultAssigneeId)?.fullName ?? 'a member'}.`
              : 'New tasks start unassigned.'}{' '}
            You do not have permission to change it.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
        <h2 className="text-sm font-semibold tracking-tight">Phase notifications</h2>
        <p className="text-[13px] text-muted">
          Who hears, in their Action Center, when this project&apos;s status or a Phase 2, 3 or 4 workspace changes state.
        </p>
        <WatchersPanel projectId={projectId} watchers={defaults.watchers} roster={members} mayManageOthers={mayManageWatchers} selfId={context.userId} />
      </section>

      <Callout tone="info">
        Project templates: save this project as a template from its header (&ldquo;Save as template&rdquo;),
        start a new project from one in ⌘K › Create project, and manage them under{' '}
        <Link href="/settings/templates" className="underline">Settings › Templates</Link>.
      </Callout>
    </div>
  );
}
