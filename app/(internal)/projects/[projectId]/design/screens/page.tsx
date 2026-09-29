import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { listMappableScopeItems, readScreenListState } from '@/modules/projects/screen-edit-queries';
import { listProjectScreens, type ProjectScreen } from '@/modules/projects/screens-queries';
import {
  Badge,
  Callout,
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
import { AddScreenForm, DESIGN_STATE_LABEL, DesignStateForm, MERGE_FORM_ID, MergeScreensForm, SplitScreenForm } from './screen-forms';

export const metadata: Metadata = { title: 'Screen inventory' };

/**
 * The Screen Inventory — SCR-034. Every row of `projects.screens` for this
 * project, printed as stored, and the controls a person has over it. Add,
 * merge (tick rows) and split change which screens exist and are drawn only
 * while the screen list is open (no baseline yet, or a draft one); once the
 * latest baseline is finalized the page says so and the row trigger refuses
 * regardless (migration 20260929200000). The design state per row is
 * drawing progress and stays writable after finalization.
 *
 * Superseded screens (merged or split away) are history and hidden behind
 * `?superseded=1`; they are neither coverage nor a gap on the Overview.
 */
export default async function ProjectScreensPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ superseded?: string }>;
}) {
  const { projectId } = await params;
  const { superseded } = await searchParams;
  const showSuperseded = superseded === '1';

  const context = await requireInternal(`/projects/${projectId}/design/screens`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [allScreens, listState, scopeItems, clock, clientName] = await Promise.all([
    listProjectScreens(projectId),
    readScreenListState(projectId),
    listMappableScopeItems(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const mayEdit = can(context, 'project.write');
  // Add, merge and split change WHICH screens exist and follow the baseline;
  // the design state is drawing progress and stays writable after it.
  const editable = mayEdit && listState.open;

  const supersededCount = allScreens.filter((s) => s.status === 'superseded').length;
  const screens = showSuperseded ? allScreens : allScreens.filter((s) => s.status !== 'superseded');
  const live = allScreens.filter((s) => s.status !== 'superseded');

  const byStatus = new Map<string, number>();
  for (const s of live) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const statusCaption = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${n} ${humanize(status).toLowerCase()}`)
    .join(' · ');

  const withSections = live.filter((s) => s.required_sections && s.required_sections.trim().length > 0).length;
  const drawn = live.filter((s) => s.design_state === 'drawn' || s.design_state === 'reviewed').length;
  const fullyStated = live.filter((s) => s.has_empty_state && s.has_error_state && s.has_loading_state && s.has_success_state).length;
  const submitted = live.filter((s) => s.qa_status === 'submitted').length;
  const keyById = new Map(allScreens.map((s) => [s.id, s.screen_key]));

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
    ...(editable
      ? [
          {
            key: 'pick',
            header: '',
            width: '1%',
            cell: (s: ProjectScreen) =>
              s.status === 'superseded' ? null : <input type="checkbox" name="sourceIds" value={s.id} form={MERGE_FORM_ID} aria-label={`Select ${s.name} to merge`} />,
          } satisfies Column<ProjectScreen>,
        ]
      : []),
    {
      key: 'name',
      header: 'Screen',
      primary: true,
      cell: (s) => (
        <span className="flex flex-col">
          <Link href={`/projects/${projectId}/design/screens/${s.id}`} className={`font-medium hover:underline ${s.status === 'superseded' ? 'text-muted line-through' : 'text-foreground'}`}>
            {s.name}
          </Link>
          {s.superseded_by ? <span className="text-xs text-muted">superseded by {keyById.get(s.superseded_by) ?? s.superseded_by}</span> : null}
        </span>
      ),
    },
    { key: 'key', header: 'Key', cellClassName: 'font-mono text-xs text-muted whitespace-nowrap', cell: (s) => s.screen_key },
    { key: 'status', header: 'Status', badge: true, cell: (s) => <StatusBadge status={s.status} dot={false} /> },
    {
      key: 'design',
      header: 'Design',
      cell: (s) =>
        mayEdit && s.status !== 'superseded' ? (
          <DesignStateForm projectId={projectId} screenId={s.id} current={s.design_state} compact />
        ) : (
          <span className="whitespace-nowrap">{DESIGN_STATE_LABEL[s.design_state] ?? humanize(s.design_state)}</span>
        ),
    },
    { key: 'qa', header: 'QA', desktopOnly: true, cell: (s) => (s.qa_status === 'submitted' ? <Badge tone="info" dot={false}>submitted</Badge> : <span className="text-muted">—</span>) },
    { key: 'role', header: 'Role', desktopOnly: true, cell: (s) => humanize(s.user_role) },
    { key: 'states', header: 'States', cell: stateChips },
    { key: 'baseline', header: 'Baseline', align: 'right', cellClassName: 'tabular whitespace-nowrap', cell: (s) => (s.baseline_version === null ? <span className="text-muted">—</span> : `v${s.baseline_version}`) },
    { key: 'updated', header: 'Updated', align: 'right', desktopOnly: true, cellClassName: 'text-muted whitespace-nowrap', cell: (s) => clock.dateTime(s.updated_at) },
    {
      key: 'open',
      header: '',
      align: 'right',
      width: '1%',
      cell: (s) => (
        <span className="flex flex-col items-end gap-1">
          <Link href={`/projects/${projectId}/design/screens/${s.id}`} className="text-[13px] text-muted underline hover:text-foreground">
            Detail
          </Link>
          {editable && s.status !== 'superseded' ? <SplitScreenForm projectId={projectId} sourceId={s.id} sourceKey={s.screen_key} /> : null}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayEdit} />
      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <StatGrid cols={4}>
        <Stat label="Screens" value={String(live.length)} caption={supersededCount > 0 ? `${supersededCount} superseded` : live.length > 0 ? statusCaption : 'None recorded'} tone="brand" icon={<IconFile size={16} />} />
        <Stat label="Drawn or reviewed" value={String(drawn)} caption={live.length > 0 ? `${live.length - drawn} not yet` : undefined} tone={live.length > 0 && drawn < live.length ? 'warning' : 'success'} icon={<IconList size={16} />} />
        <Stat label="With required sections" value={String(withSections)} caption={live.length > 0 ? `${fullyStated} with all four states` : undefined} tone={live.length > 0 && withSections < live.length ? 'warning' : 'success'} icon={<IconCheck size={16} />} />
        <Stat label="Submitted for QA" value={String(submitted)} caption={listState.latest ? `Baseline v${listState.latest.version} · ${listState.latest.status}` : 'No screen baseline drafted'} tone="info" icon={<IconShare size={16} />} />
      </StatGrid>

      {mayEdit && !listState.open ? (
        <Callout tone="info" title={`The screen list is closed: ${listState.closedBy}.`}>
          A finalized baseline is what was agreed. Draft the next baseline version from the Design overview to add, merge or split a screen or change what it covers; the database refuses those writes until then. Design state, Figma links and QA hand-off stay open.
        </Callout>
      ) : null}

      {editable ? (
        <div className="flex flex-col gap-3">
          <AddScreenForm projectId={projectId} scopeItems={scopeItems} />
          <MergeScreensForm projectId={projectId} />
        </div>
      ) : null}

      <Card>
        <CardHeader
          title={`Inventory (${screens.length})`}
          description={showSuperseded ? 'Every screen recorded for this project, superseded ones included.' : 'Every live screen recorded for this project, as stored. Open a row for the full definition.'}
          actions={
            supersededCount > 0 ? (
              <Link href={showSuperseded ? `/projects/${projectId}/design/screens` : `/projects/${projectId}/design/screens?superseded=1`} className="text-xs underline hover:text-foreground">
                {showSuperseded ? 'Hide superseded' : `Show ${supersededCount} superseded`}
              </Link>
            ) : undefined
          }
        />
        {screens.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5">
            <EmptyState icon={<IconFile size={20} />} title="No screen has been recorded" description={editable ? 'Add the first screen above, or let Phase 3 draft the inventory from the plan.' : 'Screens appear here once Phase 3 drafts the screen baseline from the plan. Nothing is listed until then.'} />
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
