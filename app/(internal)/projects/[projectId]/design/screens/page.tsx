import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { listProjectScreens, type ProjectScreen } from '@/modules/projects/screens-queries';
import {
  Badge,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  humanize,
  IconCheck,
  IconFile,
  IconList,
  IconShare,
  PermissionDenied,
  Stat,
  StatGrid,
  StatusBadge,
  type Column,
} from '@/ui';

import { ProjectSubNav } from '../../project-subnav';
import { WorkspaceHeader } from '../../workspace-header';
import { DesignSubNav } from '../design-subnav';

export const metadata: Metadata = { title: 'Screen inventory' };

/**
 * The Screen Inventory — SCR-034. Every row of `projects.screens` for this
 * project, printed as stored: the key, the role it serves, how it behaves on
 * a small screen, which of the four states (empty / error / loading /
 * success) somebody has recorded, and the baseline version it belongs to.
 * The Overview's "Screen coverage" section shows what §9 flags; this is the
 * list itself. Nothing here writes — a screen is added, merged or split by
 * the Phase 3 tooling, not by this page.
 */
export default async function ProjectScreensPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design/screens`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [screens, clock, clientName] = await Promise.all([
    listProjectScreens(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const mayEdit = can(context.role, 'project.write');

  const byStatus = new Map<string, number>();
  for (const s of screens) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const statusCaption = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${n} ${humanize(status).toLowerCase()}`)
    .join(' · ');

  const withSections = screens.filter((s) => s.required_sections && s.required_sections.trim().length > 0).length;
  const withDependencies = screens.filter((s) => s.dependencies && s.dependencies.trim().length > 0).length;
  const fullyStated = screens.filter((s) => s.has_empty_state && s.has_error_state && s.has_loading_state && s.has_success_state).length;
  const approved = byStatus.get('approved') ?? 0;

  const stateChips = (s: ProjectScreen) => {
    const states: { label: string; on: boolean }[] = [
      { label: 'empty', on: s.has_empty_state },
      { label: 'error', on: s.has_error_state },
      { label: 'loading', on: s.has_loading_state },
      { label: 'success', on: s.has_success_state },
    ];
    return (
      <span className="flex flex-wrap gap-1">
        {states.map((st) => (
          <Badge key={st.label} tone={st.on ? 'success' : 'neutral'} dot={false} className={st.on ? undefined : 'opacity-60'}>
            {st.label}
          </Badge>
        ))}
      </span>
    );
  };

  const columns: Column<ProjectScreen>[] = [
    {
      key: 'name',
      header: 'Screen',
      primary: true,
      cell: (s) => (
        <Link href={`/projects/${projectId}/design/screens/${s.id}`} className="font-medium text-foreground hover:underline">
          {s.name}
        </Link>
      ),
    },
    { key: 'key', header: 'Key', cellClassName: 'font-mono text-xs text-muted whitespace-nowrap', cell: (s) => s.screen_key },
    { key: 'status', header: 'Status', badge: true, cell: (s) => <StatusBadge status={s.status} dot={false} /> },
    { key: 'role', header: 'Role', cell: (s) => humanize(s.user_role) },
    { key: 'responsive', header: 'Responsive', desktopOnly: true, cellClassName: 'max-w-[18rem] truncate text-muted', cell: (s) => s.responsive_behaviour ?? <span className="text-muted">—</span> },
    { key: 'states', header: 'States', cell: stateChips },
    { key: 'baseline', header: 'Baseline', align: 'right', cellClassName: 'tabular whitespace-nowrap', cell: (s) => (s.baseline_version === null ? <span className="text-muted">—</span> : `v${s.baseline_version}`) },
    { key: 'updated', header: 'Updated', align: 'right', desktopOnly: true, cellClassName: 'text-muted whitespace-nowrap', cell: (s) => clock.dateTime(s.updated_at) },
    {
      key: 'open',
      header: '',
      align: 'right',
      desktopOnly: true,
      width: '1%',
      cell: (s) => (
        <Link href={`/projects/${projectId}/design/screens/${s.id}`} className="text-[13px] text-muted underline hover:text-foreground">
          Detail
        </Link>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayEdit} />
      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <StatGrid cols={4}>
        <Stat label="Screens" value={String(screens.length)} caption={screens.length > 0 ? `${approved} approved` : 'None recorded'} tone="brand" icon={<IconFile size={16} />} />
        <Stat label="By status" value={String(byStatus.size)} caption={statusCaption || 'No status to count'} tone="info" icon={<IconList size={16} />} />
        <Stat label="With required sections" value={String(withSections)} caption={screens.length > 0 ? `${screens.length - withSections} without` : undefined} tone={screens.length > 0 && withSections < screens.length ? 'warning' : 'success'} icon={<IconCheck size={16} />} />
        <Stat label="With dependencies" value={String(withDependencies)} caption={screens.length > 0 ? `${fullyStated} with all four states` : undefined} tone="neutral" icon={<IconShare size={16} />} />
      </StatGrid>

      <Card>
        <CardHeader title={`Inventory (${screens.length})`} description="Every screen recorded for this project, as stored. Open a row for the full definition." />
        {screens.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5">
            <EmptyState icon={<IconFile size={20} />} title="No screen has been recorded" description="Screens appear here once Phase 3 drafts the screen baseline from the plan. Nothing is listed until then." />
          </div>
        ) : (
          <div className="px-4 pb-4 sm:px-5">
            <DataTable dense rows={screens} columns={columns} getKey={(s) => s.id} />
          </div>
        )}
      </Card>
    </div>
  );
}
