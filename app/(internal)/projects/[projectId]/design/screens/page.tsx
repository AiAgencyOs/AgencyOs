import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { listMappableScopeItems, readScreenListState } from '@/modules/projects/screen-edit-queries';
import { countScopeLinksByScreen } from '@/modules/projects/screen-inventory-queries';
import { coverageOf, DEVICE_TARGETS } from '@/modules/projects/screen-states-schema';
import { listProjectScreens, type ProjectScreen } from '@/modules/projects/screens-queries';
import {
  Badge,
  buttonClass,
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
  labelClass,
  PermissionDenied,
  selectClass,
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
 * Bucket F (migration 20261001130000): the approved and missing counts as
 * tiles, filters by role, device and status (GET form, `searchParams`),
 * grouping by role, the requirement-link count per row and the responsive
 * coverage column read from `device_targets` × `responsive_coverage`.
 *
 * Superseded screens (merged or split away) are history and hidden behind
 * `?superseded=1`; they are neither coverage nor a gap on the Overview.
 */
export default async function ProjectScreensPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ superseded?: string; role?: string; device?: string; status?: string; group?: string; missing?: string }>;
}) {
  const { projectId } = await params;
  const { superseded, role, device, status, group, missing } = await searchParams;
  const showSuperseded = superseded === '1';

  const context = await requireInternal(`/projects/${projectId}/design/screens`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [allScreens, listState, scopeItems, scopeLinks, clock, clientName] = await Promise.all([
    listProjectScreens(projectId),
    readScreenListState(projectId),
    listMappableScopeItems(projectId),
    countScopeLinksByScreen(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const mayEdit = can(context, 'project.write');
  // Add, merge and split change WHICH screens exist and follow the baseline;
  // the design state is drawing progress and stays writable after it.
  const editable = mayEdit && listState.open;

  const supersededCount = allScreens.filter((s) => s.status === 'superseded').length;
  const live = allScreens.filter((s) => s.status !== 'superseded');
  const fullyStated = (s: ProjectScreen) => s.has_empty_state && s.has_error_state && s.has_loading_state && s.has_success_state;

  // SCR-034 — the filters, from the URL.
  const roleFilter = (role ?? '').trim();
  const deviceFilter = (device ?? '').trim();
  const statusFilter = (status ?? '').trim();
  const missingOnly = missing === '1';
  const filtered = (showSuperseded ? allScreens : live).filter(
    (s) =>
      (!roleFilter || s.user_role === roleFilter)
      && (!deviceFilter || (s.device_targets ?? []).includes(deviceFilter))
      && (!statusFilter || s.status === statusFilter)
      && (!missingOnly || !fullyStated(s)),
  );
  const screens = filtered;
  const roles = [...new Set(live.map((s) => s.user_role))].sort();
  const grouped = group === 'role';

  const byStatus = new Map<string, number>();
  for (const s of live) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const statusCaption = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([st, n]) => `${n} ${humanize(st).toLowerCase()}`)
    .join(' · ');

  const approved = live.filter((s) => s.status === 'approved').length;
  const missingStates = live.filter((s) => !fullyStated(s)).length;
  const drawn = live.filter((s) => s.design_state === 'drawn' || s.design_state === 'reviewed').length;
  const submitted = live.filter((s) => s.qa_status === 'submitted').length;
  const withTargets = live.filter((s) => (s.device_targets ?? []).length > 0);
  const fullyCovered = withTargets.filter((s) => {
    const c = coverageOf(s.device_targets ?? [], s.responsive_coverage);
    return c !== null && c.covered === c.total;
  }).length;
  const unmapped = live.filter((s) => (scopeLinks.get(s.id) ?? 0) === 0).length;
  const keyById = new Map(allScreens.map((s) => [s.id, s.screen_key]));
  const base = `/projects/${projectId}/design/screens`;

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
          <Link href={`${base}/${s.id}`} className={`font-medium hover:underline ${s.status === 'superseded' ? 'text-muted line-through' : 'text-foreground'}`}>
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
    ...(grouped ? [] : [{ key: 'role', header: 'Role', desktopOnly: true, cell: (s: ProjectScreen) => humanize(s.user_role) } satisfies Column<ProjectScreen>]),
    {
      key: 'devices',
      header: 'Devices',
      desktopOnly: true,
      cell: (s) => ((s.device_targets ?? []).length === 0 ? <span className="text-muted">—</span> : (s.device_targets ?? []).join(', ')),
    },
    {
      key: 'coverage',
      header: 'Responsive',
      align: 'right',
      cellClassName: 'tabular whitespace-nowrap',
      cell: (s) => {
        const c = coverageOf(s.device_targets ?? [], s.responsive_coverage);
        if (!c) return <span className="text-muted">no targets</span>;
        return <span className={c.covered === c.total ? 'text-success' : 'text-warning'}>{c.covered}/{c.total}</span>;
      },
    },
    { key: 'states', header: 'States', cell: stateChips },
    {
      key: 'links',
      header: 'Requirements',
      align: 'right',
      cellClassName: 'tabular whitespace-nowrap',
      cell: (s) => {
        const n = scopeLinks.get(s.id) ?? 0;
        return (
          <Link href={`${base}/${s.id}`} className={n === 0 ? 'text-warning underline-offset-2 hover:underline' : 'underline-offset-2 hover:underline'}>
            {n === 0 ? 'unmapped' : `${n} linked`}
          </Link>
        );
      },
    },
    { key: 'baseline', header: 'Baseline', align: 'right', cellClassName: 'tabular whitespace-nowrap', desktopOnly: true, cell: (s) => (s.baseline_version === null ? <span className="text-muted">—</span> : `v${s.baseline_version}`) },
    { key: 'updated', header: 'Updated', align: 'right', desktopOnly: true, cellClassName: 'text-muted whitespace-nowrap', cell: (s) => clock.dateTime(s.updated_at) },
    {
      key: 'open',
      header: '',
      align: 'right',
      width: '1%',
      cell: (s) => (
        <span className="flex flex-col items-end gap-1">
          <Link href={`${base}/${s.id}`} className="text-[13px] text-muted underline hover:text-foreground">
            Detail
          </Link>
          {editable && s.status !== 'superseded' ? <SplitScreenForm projectId={projectId} sourceId={s.id} sourceKey={s.screen_key} /> : null}
        </span>
      ),
    },
  ];

  const groups = grouped
    ? [...new Set(screens.map((s) => s.user_role))].sort().map((r) => ({ role: r, rows: screens.filter((s) => s.user_role === r) }))
    : [{ role: null as string | null, rows: screens }];

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayEdit} />
      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <StatGrid cols={6}>
        <Stat label="Screens" value={String(live.length)} caption={supersededCount > 0 ? `${supersededCount} superseded` : live.length > 0 ? statusCaption : 'None recorded'} tone="brand" icon={<IconFile size={16} />} href={base} />
        <Stat label="Approved" value={String(approved)} caption={live.length > 0 ? `${live.length - approved} not yet` : undefined} tone={live.length > 0 && approved === live.length ? 'success' : 'info'} icon={<IconCheck size={16} />} href={`${base}?status=approved`} />
        <Stat label="Missing states" value={String(missingStates)} caption="not all four states recorded" tone={missingStates > 0 ? 'warning' : 'success'} icon={<IconList size={16} />} href={`${base}?missing=1`} />
        <Stat label="Drawn or reviewed" value={String(drawn)} caption={live.length > 0 ? `${live.length - drawn} not yet` : undefined} tone={live.length > 0 && drawn < live.length ? 'warning' : 'success'} icon={<IconList size={16} />} />
        <Stat label="Responsive coverage" value={withTargets.length === 0 ? '—' : `${fullyCovered}/${withTargets.length}`} caption={withTargets.length === 0 ? 'no device targets recorded' : `${unmapped} unmapped to scope`} tone={withTargets.length > 0 && fullyCovered < withTargets.length ? 'warning' : 'success'} icon={<IconCheck size={16} />} />
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
              <Link href={showSuperseded ? base : `${base}?superseded=1`} className="text-xs underline hover:text-foreground">
                {showSuperseded ? 'Hide superseded' : `Show ${supersededCount} superseded`}
              </Link>
            ) : undefined
          }
        />
        {/* SCR-034 — role / device / status filters and grouping, as a GET form. */}
        <form method="get" className="flex flex-wrap items-end gap-2 px-4 pb-3 sm:px-5">
          {showSuperseded ? <input type="hidden" name="superseded" value="1" /> : null}
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Role</label>
            <select name="role" defaultValue={roleFilter} className={selectClass}>
              <option value="">All roles</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Device</label>
            <select name="device" defaultValue={deviceFilter} className={selectClass}>
              <option value="">All devices</option>
              {DEVICE_TARGETS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Status</label>
            <select name="status" defaultValue={statusFilter} className={selectClass}>
              <option value="">All statuses</option>
              {['draft', 'in_review', 'approved'].map((st) => (
                <option key={st} value={st}>
                  {humanize(st)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Group</label>
            <select name="group" defaultValue={grouped ? 'role' : ''} className={selectClass}>
              <option value="">No grouping</option>
              <option value="role">By role</option>
            </select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-[13px]">
            <input type="checkbox" name="missing" value="1" defaultChecked={missingOnly} /> missing states only
          </label>
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Apply
          </button>
          {roleFilter || deviceFilter || statusFilter || grouped || missingOnly ? (
            <Link href={showSuperseded ? `${base}?superseded=1` : base} className="pb-2 text-xs underline hover:text-foreground">
              Clear
            </Link>
          ) : null}
        </form>
        {screens.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5">
            <EmptyState
              icon={<IconFile size={20} />}
              title={live.length === 0 ? 'No screen has been recorded' : 'No screen matches these filters'}
              description={live.length === 0 ? (editable ? 'Add the first screen above, or let Phase 3 draft the inventory from the plan.' : 'Screens appear here once Phase 3 drafts the screen baseline from the plan. Nothing is listed until then.') : 'Clear a filter to see the rest of the inventory.'}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
            {groups.map((g) => (
              <div key={g.role ?? 'all'} className="flex flex-col gap-2">
                {g.role ? (
                  <h3 className="text-[13px] font-semibold tracking-tight">
                    {humanize(g.role)} <span className="font-normal text-muted">({g.rows.length})</span>
                  </h3>
                ) : null}
                <DataTable dense rows={g.rows} columns={columns} getKey={(s) => s.id} />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
