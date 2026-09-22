import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDeliverables } from '@/modules/projects/queries';
import { Badge, Callout, Card, EmptyState, humanize, IconProjects, PageHeader, statusTone } from '@/ui';

import { AddBuildForm, SubmitDeliverableForm } from '../deliverables-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Builds' };

/**
 * SCR-043's Builds half — Environments and Dependencies are deliberately not
 * on this page. The traceability sweep found nothing anywhere in the schema
 * tracking a deployment environment or a dependency version, and inventing
 * that model wasn't this pass's call to make; a Callout says so rather than
 * the page silently pretending to be the whole spec'd screen.
 *
 * Builds themselves reuse the same `deliverables` reader Prototype (SCR-037)
 * does, filtered to `kind = 'build'` — no new backend, same relationship
 * Board has to Development.
 */
export default async function BuildsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/builds`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const canWrite = can(context.role, 'project.write');
  const builds = (await listDeliverables(projectId)).filter((d) => d.kind === 'build');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Builds`}
        description={builds.length === 0 ? 'No builds yet.' : `${builds.length} version${builds.length === 1 ? '' : 's'}.`}
      />

      <ProjectSubNav projectId={projectId} />

      <Callout tone="info">
        Environments and dependency tracking are not built — nothing in this product records a
        deployment environment or a package version today, and this page does not invent one.
      </Callout>

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
    </div>
  );
}
