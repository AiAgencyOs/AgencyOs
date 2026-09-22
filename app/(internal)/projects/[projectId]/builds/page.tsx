import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDependencies, listDeliverables, listEnvironments } from '@/modules/projects/queries';
import { Badge, Card, EmptyState, humanize, IconIntegrations, IconProjects, PageHeader, statusTone } from '@/ui';

import { AddBuildForm, SubmitDeliverableForm } from '../deliverables-panel';
import {
  AddDependencyForm,
  AddEnvironmentForm,
  DependencyCard,
  EnvironmentCard,
} from '../environments-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Builds' };

/**
 * SCR-043 — Builds, Environments and Dependencies. Builds reuse the same
 * `deliverables` reader Prototype (SCR-037) does, filtered to `kind = 'build'`
 * — no new backend, same relationship Board has to Development. Environments
 * and Dependencies, added 2026-09-22, follow the exact "link, never a blob"
 * precedent `project_files`/`repositories` already set (see the migration,
 * 20260922140000_where_it_runs_and_what_it_runs_on.sql) — this page went
 * without them only because inventing that model was not an earlier pass's
 * call to make, on the owner's explicit instruction to decide the remaining
 * deferred screens rather than leave each one open.
 */
export default async function BuildsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/builds`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const canWrite = can(context.role, 'project.write');
  const [deliverables, environments, dependencies] = await Promise.all([
    listDeliverables(projectId),
    listEnvironments(projectId),
    listDependencies(projectId),
  ]);
  const builds = deliverables.filter((d) => d.kind === 'build');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Builds`}
        description={builds.length === 0 ? 'No builds yet.' : `${builds.length} version${builds.length === 1 ? '' : 's'}.`}
      />

      <ProjectSubNav projectId={projectId} />

      {builds.length > 0 ? (
        <div className="flex flex-col gap-2">
          {builds.map((b) => (
            <Card key={b.id} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  v{b.version} — {b.title}
                </span>
                <Badge tone={statusTone(b.status)}>{humanize(b.status)}</Badge>
              </div>
              {b.changelog ? <p className="mt-1 text-sm text-muted">{b.changelog}</p> : null}
              {b.known_issues ? <p className="mt-1 text-xs text-warning">Known issues: {b.known_issues}</p> : null}
              {b.artifact_url ? (
                <a
                  href={b.artifact_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 inline-block break-all text-xs underline underline-offset-2"
                >
                  {b.artifact_url}
                </a>
              ) : null}
              <p className="mt-1 text-xs text-faint">Added {clock.dateTime(b.created_at)}</p>
              {canWrite && b.status === 'draft' ? (
                <SubmitDeliverableForm deliverableId={b.id} projectId={projectId} />
              ) : null}
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="No builds yet"
          description="Add the first build below once it's ready to review."
        />
      )}

      {canWrite ? (
        <Card className="p-4">
          <AddBuildForm projectId={projectId} />
        </Card>
      ) : null}

      <PageHeader
        title="Environments"
        description={
          environments.length === 0
            ? 'No environments linked yet.'
            : `${environments.length} environment${environments.length === 1 ? '' : 's'}.`
        }
      />
      {environments.length > 0 ? (
        <div className="flex flex-col gap-2">
          {environments.map((e) => (
            <EnvironmentCard key={e.id} environment={e} projectId={projectId} editable={canWrite} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconIntegrations size={22} />}
          title="No environments yet"
          description="Link the environment below once there is one to point at."
        />
      )}
      {canWrite ? <AddEnvironmentForm projectId={projectId} /> : null}

      <PageHeader
        title="Dependencies"
        description={
          dependencies.length === 0
            ? 'No dependencies recorded yet.'
            : `${dependencies.length} dependenc${dependencies.length === 1 ? 'y' : 'ies'}.`
        }
      />
      {dependencies.length > 0 ? (
        <div className="flex flex-col gap-2">
          {dependencies.map((d) => (
            <DependencyCard key={d.id} dependency={d} projectId={projectId} editable={canWrite} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconIntegrations size={22} />}
          title="No dependencies yet"
          description="Add the first dependency below once there is one worth recording."
        />
      )}
      {canWrite ? <AddDependencyForm projectId={projectId} /> : null}
    </div>
  );
}
