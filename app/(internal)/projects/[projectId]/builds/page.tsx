import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDependencies, listDeliverables, listEnvironments, readPlanBoard } from '@/modules/projects/queries';
import { Badge, Card, EmptyState, humanize, IconIntegrations, IconProjects, PageHeader, Stat, StatGrid, statusTone, PermissionDenied } from '@/ui';

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
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const canWrite = can(context.role, 'project.write');
  const [deliverables, environments, dependencies, board] = await Promise.all([
    listDeliverables(projectId),
    listEnvironments(projectId),
    listDependencies(projectId),
    readPlanBoard(projectId),
  ]);
  const builds = deliverables.filter((d) => d.kind === 'build');
  // SCR-043 — three figures from rows this page already reads, plus the
  // plan's dependency register. A dependency is "blocking" while it is
  // pending, requested or blocked; `received` and `not_applicable` are the
  // two ways it stops being one. There is no door here to mark one
  // supplied: the register belongs to the plan, and the database refuses a
  // write to it once the plan is active (a change is the next plan version).
  const latestBuild = builds[0] ?? null;
  const environmentKinds = [...new Set(environments.map((e) => e.kind))];
  const blockingDependencies = board.dependencies.filter((d) => ['pending', 'requested', 'blocked'].includes(d.status));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Builds`}
        description={builds.length === 0 ? 'No builds yet.' : `${builds.length} version${builds.length === 1 ? '' : 's'}.`}
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={4}>
        <Stat
          label="Latest build"
          value={latestBuild ? `v${latestBuild.version}` : '—'}
          caption={latestBuild ? `${humanize(latestBuild.status)} · ${clock.date(latestBuild.created_at)}` : 'no build recorded'}
          tone={latestBuild ? statusTone(latestBuild.status) : 'neutral'}
        />
        <Stat
          label="Environments linked"
          value={String(environments.length)}
          caption={environmentKinds.length > 0 ? environmentKinds.map((k) => humanize(k)).join(', ') : 'none linked yet'}
          tone={environments.length > 0 ? 'success' : 'warning'}
        />
        <Stat
          label="Dependency blockers"
          value={String(blockingDependencies.length)}
          caption={board.plan ? `on plan v${board.plan.version} · ${board.dependencies.length - blockingDependencies.length} settled` : 'no plan yet'}
          tone={blockingDependencies.some((d) => d.status === 'blocked') ? 'danger' : blockingDependencies.length > 0 ? 'warning' : 'success'}
          href={`/projects/${projectId}/plan`}
        />
        <Stat label="Technical dependencies" value={String(dependencies.length)} caption="recorded below" />
      </StatGrid>

      {blockingDependencies.length > 0 ? (
        <Card className="p-4">
          <p className="text-[13px] font-medium">Waiting on</p>
          <ul className="mt-1 flex flex-col gap-1 text-[13px]">
            {blockingDependencies.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{d.description}</span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {humanize(d.kind)} · {d.ownerRole}
                  <Badge tone={d.status === 'blocked' ? 'danger' : 'warning'}>{d.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Marking one received is a change to the plan's register, which the database accepts only on a draft plan — open the next plan version on the Plan tab.
          </p>
        </Card>
      ) : null}

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
