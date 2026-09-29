import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { getProjectScreen, splitList } from '@/modules/projects/screens-queries';
import { Badge, Card, CardHeader, DetailPanel, humanize, PermissionDenied, StatusBadge } from '@/ui';

import { ProjectSubNav } from '../../../project-subnav';
import { WorkspaceHeader } from '../../../workspace-header';
import { DesignSubNav } from '../../design-subnav';

export const metadata: Metadata = { title: 'Screen' };

/**
 * One screen of the inventory — SCR-034's detail. Every column of
 * `projects.screens` is printed, the free-text ones as prose and the two
 * list-shaped ones (required sections, dependencies) as lists where the
 * stored text separates its items. A screen that is not this project's is
 * absent, not forbidden.
 */
export default async function ProjectScreenPage({ params }: { params: Promise<{ projectId: string; screenId: string }> }) {
  const { projectId, screenId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design/screens/${screenId}`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const screen = await getProjectScreen(projectId, screenId);
  if (!screen) notFound();

  const [clock, clientName] = await Promise.all([agencyClock(), project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null)]);
  const mayEdit = can(context.role, 'project.write');

  const text = (v: string | null) => (v && v.trim().length > 0 ? <span className="whitespace-pre-wrap">{v}</span> : <span className="text-muted">Not recorded</span>);
  const flag = (on: boolean) => <Badge tone={on ? 'success' : 'neutral'}>{on ? 'Recorded' : 'Not recorded'}</Badge>;

  const sections = splitList(screen.required_sections);
  const dependencies = splitList(screen.dependencies);

  const ListCard = ({ title, hint, items, empty }: { title: string; hint: string; items: string[]; empty: string }) => (
    <Card>
      <CardHeader title={`${title} (${items.length})`} description={hint} />
      <div className="px-4 pb-4 sm:px-5">
        {items.length === 0 ? (
          <p className="text-[13px] text-muted">{empty}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item, i) => (
              <li key={`${i}-${item}`} className="rounded-md border border-line px-3 py-2 text-[13px]">
                {item}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayEdit} />
      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="truncate text-lg font-semibold text-foreground">{screen.name}</h2>
          <Badge tone="neutral" mono>
            {screen.screen_key}
          </Badge>
          <StatusBadge status={screen.status} />
        </div>
        <Link href={`/projects/${projectId}/design/screens`} className="text-[13px] text-muted underline hover:text-foreground">
          All screens
        </Link>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <DetailPanel
            title="Definition"
            rows={[
              { label: 'Purpose', value: text(screen.purpose) },
              { label: 'User role', value: humanize(screen.user_role) },
              { label: 'Entry point', value: text(screen.entry_point) },
              { label: 'Exit action', value: text(screen.exit_action) },
              { label: 'Actions', value: text(screen.actions) },
              { label: 'Required data', value: text(screen.required_data) },
              { label: 'Validation', value: text(screen.validation) },
              { label: 'Permission behaviour', value: text(screen.permission_behaviour) },
              { label: 'Responsive behaviour', value: text(screen.responsive_behaviour) },
              { label: 'Accessibility notes', value: text(screen.accessibility_notes) },
            ]}
          />

          <ListCard title="Required sections" hint="The sections this screen must carry, as stored on the screen." items={sections} empty="No required section is recorded for this screen." />
          <ListCard title="Dependencies" hint="What this screen depends on — other screens, data or decisions — as stored." items={dependencies} empty="No dependency is recorded for this screen." />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <DetailPanel
            title="States"
            rows={[
              { label: 'Empty state', value: flag(screen.has_empty_state) },
              { label: 'Error state', value: flag(screen.has_error_state) },
              { label: 'Loading state', value: flag(screen.has_loading_state) },
              { label: 'Success state', value: flag(screen.has_success_state) },
            ]}
          />
          <DetailPanel
            title="Record"
            rows={[
              { label: 'Screen', value: screen.name },
              { label: 'Key', value: <span className="font-mono text-xs">{screen.screen_key}</span> },
              { label: 'Status', value: <StatusBadge status={screen.status} dot={false} /> },
              { label: 'Baseline version', value: screen.baseline_version === null ? <span className="text-muted">Not in a baseline</span> : `v${screen.baseline_version}` },
              { label: 'Deliverable', value: screen.deliverable_id ? <span className="font-mono text-xs">{screen.deliverable_id}</span> : <span className="text-muted">None linked</span> },
              { label: 'Project', value: project.name },
              { label: 'Organization', value: <span className="font-mono text-xs">{screen.organization_id}</span> },
              { label: 'Created', value: clock.dateTime(screen.created_at) },
              { label: 'Created by', value: screen.created_by ? <span className="font-mono text-xs">{screen.created_by}</span> : <span className="text-muted">Not recorded</span> },
              { label: 'Updated', value: clock.dateTime(screen.updated_at) },
              { label: 'Id', value: <span className="font-mono text-xs">{screen.id}</span> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
