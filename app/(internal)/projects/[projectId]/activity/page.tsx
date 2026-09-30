import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listPaymentPlan } from '@/modules/projects/queries';
import { actionLabel, recordHref } from '@/modules/projects/project-activity';
import { readProjectActivity } from '@/modules/projects/project-activity-queries';
import Link from 'next/link';

import { Badge, EmptyState, IconClock, PageHeader, PermissionDenied } from '@/ui';

import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Activity' };

/**
 * SCR-027's activity timeline, built from the AUDIT TRAIL as well as the
 * records' own dates. `projects.project_activity` (a read door) returns the
 * audit rows whose subject is this project or a record inside it — tasks,
 * milestones, files, folders, scope, deliverables, defects, members, notes,
 * sprints, meetings — to any internal reader, with the actor's name and never
 * the before/after snapshots (those stay on /audit for owners and ops admins).
 * Domain events (a task completed, a milestone met, a change request raised or
 * decided) are merged in, and each row links to its record.
 */
export default async function ProjectActivityPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/activity`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const [{ tasks }, milestones] = await Promise.all([listDevelopmentBreakdown(projectId), listPaymentPlan(projectId)]);
  const entries = await readProjectActivity(projectId, { tasks, milestones });
  const auditCount = entries.filter((e) => e.source === 'audit').length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Activity`} description="What has happened on this project — the audit trail and each record’s own dates, most recent first." />

      <ProjectSubNav projectId={projectId} />

      {entries.length > 0 ? (
        <>
          <p className="text-xs text-muted">{entries.length} event{entries.length === 1 ? '' : 's'} · {auditCount} from the audit trail · newest first.</p>
          <ol className="flex flex-col gap-2">
            {entries.map((e) => {
              const href = recordHref(projectId, e.subjectType, e.subjectId);
              return (
                <li key={e.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-line bg-surface px-4 py-3">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge tone={e.source === 'audit' ? 'neutral' : 'info'}>{actionLabel(e.action)}</Badge>
                    {e.label ? (href ? <Link href={href} className="truncate text-sm text-foreground hover:underline">{e.label}</Link> : <span className="truncate text-sm text-foreground">{e.label}</span>) : href ? <Link href={href} className="text-sm text-muted hover:underline">Open {e.subjectType.replace(/_/g, ' ')}</Link> : null}
                    {e.actor ? <span className="text-xs text-muted">by {e.actor}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{clock.dateTime(e.at)}</span>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <EmptyState
          icon={<IconClock size={22} />}
          title="Nothing yet"
          description="Status changes, files, scope, tasks, milestones and change requests will appear here as they happen."
        />
      )}
    </div>
  );
}
