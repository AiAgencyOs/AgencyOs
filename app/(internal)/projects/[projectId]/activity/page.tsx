import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getProject,
  listDevelopmentBreakdown,
  listPaymentPlan,
  readChangeRequests,
} from '@/modules/projects/queries';
import { Badge, EmptyState, humanize, IconClock, PageHeader, statusTone } from '@/ui';

import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Activity' };

type ActivityEntry = { at: string; kind: string; label: string; detail?: string };

/**
 * SCR-027's activity piece — the other two (a dedicated Settings tab and
 * template management) are still genuinely missing and stay off this page
 * rather than being stubbed in.
 *
 * Not the audit log: `audit.audit_log` is keyed to one `(subject_type,
 * subject_id)` per row, gated to owner/ops_admin only, and has no single
 * column that says "about this project" across the many entity types a
 * project touches — reproducing that fan-out honestly was a bigger and
 * riskier change than this page's value justified. Instead this composes the
 * three readers the project workspace already has (tasks, milestones, change
 * requests) into one feed of the events each already timestamps: a task
 * completed, a milestone met, a change request raised or decided. Visible to
 * anyone with `project.read`, same as the rest of the workspace — narrower
 * than the audit log's gate, but this is a project timeline, not an audit
 * trail, and claims to be nothing more.
 */
export default async function ProjectActivityPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/activity`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const [{ tasks }, milestones, changeRequests] = await Promise.all([
    listDevelopmentBreakdown(projectId),
    listPaymentPlan(projectId),
    readChangeRequests(projectId),
  ]);

  const entries: ActivityEntry[] = [];

  for (const t of tasks) {
    if (t.completedAt) entries.push({ at: t.completedAt, kind: 'Task completed', label: t.title });
  }
  for (const m of milestones) {
    if (m.met_at) entries.push({ at: m.met_at, kind: 'Milestone met', label: m.name });
  }
  for (const cr of changeRequests) {
    entries.push({
      at: cr.createdAt,
      kind: 'Change request raised',
      label: cr.requested.length > 100 ? `${cr.requested.slice(0, 100)}…` : cr.requested,
      detail: humanize(cr.source),
    });
    if (cr.decidedAt) {
      entries.push({
        at: cr.decidedAt,
        kind: `Change request ${cr.status}`,
        label: cr.requested.length > 100 ? `${cr.requested.slice(0, 100)}…` : cr.requested,
      });
    }
  }

  entries.sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Activity`} description="What has happened on this project, most recent first." />

      <ProjectSubNav projectId={projectId} />

      {entries.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {entries.map((e, i) => (
            <li
              key={`${e.kind}-${e.at}-${i}`}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-line bg-surface px-4 py-3"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge tone={statusTone(e.kind.split(' ').pop())}>{e.kind}</Badge>
                <span className="truncate text-sm text-foreground">{e.label}</span>
                {e.detail ? <span className="text-xs text-muted">({e.detail})</span> : null}
              </span>
              <span className="shrink-0 text-xs text-muted">{clock.dateTime(e.at)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState
          icon={<IconClock size={22} />}
          title="Nothing yet"
          description="Completed tasks, met milestones and change requests will appear here as they happen."
        />
      )}
    </div>
  );
}
