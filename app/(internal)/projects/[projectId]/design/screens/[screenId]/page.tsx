import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readTestPlan } from '@/modules/qa/queries';
import { getProject } from '@/modules/projects/queries';
import { listScreenScopeItems } from '@/modules/projects/design-export-queries';
import { listDesignAssetOptions, listMappableScopeItems, listScreenAssets, readScreenListState } from '@/modules/projects/screen-edit-queries';
import { coverageOf } from '@/modules/projects/screen-states-schema';
import { getProjectScreen, listProjectScreens, splitList } from '@/modules/projects/screens-queries';
import { Badge, Callout, Card, CardHeader, DetailPanel, humanize, PermissionDenied, StatusBadge } from '@/ui';

import { ProjectSubNav } from '../../../project-subnav';
import { WorkspaceHeader } from '../../../workspace-header';
import { LinkAssetForm, UnlinkAssetForm } from '../../asset-link-forms';
import { DesignSubNav } from '../../design-subnav';
import { DESIGN_STATE_LABEL, DesignStateForm, FigmaUrlForm, MapScopeItemForm, SubmitForQaForm, UnmapScopeItemForm } from '../screen-forms';
import { ScreenStatesPanel } from '../screen-states-panel';

export const metadata: Metadata = { title: 'Screen' };

/**
 * One screen of the inventory — SCR-034/035's detail. Every column of
 * `projects.screens` is printed. A person can attach the Figma link, set
 * the design state and submit the screen for QA at any time — those happen
 * after the list is agreed — and, while the screen list is open (no
 * baseline, or a draft one), map or unmap a requirement of the active
 * scope. Once the latest baseline is finalized the page says so and the
 * mapping controls are not drawn (migration 20260929200000). Reference
 * assets (SCR-038) can be linked regardless: a link says where an image was
 * used and changes nothing about the list.
 *
 * Bucket F (migration 20261001130000): device targets, the component list
 * and responsive coverage are structured fields on the row, and the four
 * states, the role and those fields are edited after creation through
 * `projects.set_screen_states` (the panel on the right). The design preview
 * is the linked asset's image, or the Figma frame when only that exists.
 */
export default async function ProjectScreenPage({ params }: { params: Promise<{ projectId: string; screenId: string }> }) {
  const { projectId, screenId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design/screens/${screenId}`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const screen = await getProjectScreen(projectId, screenId);
  if (!screen) notFound();

  const [clock, clientName, scopeItems, listState, mappable, assets, assetOptions, testPlan, allScreens] = await Promise.all([
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    listScreenScopeItems(screen.id),
    readScreenListState(projectId),
    listMappableScopeItems(projectId),
    listScreenAssets(screen.id),
    listDesignAssetOptions(projectId),
    readTestPlan(projectId),
    listProjectScreens(projectId),
  ]);
  const mayEdit = can(context, 'project.write');
  const superseded = screen.status === 'superseded';
  // Only the mapping follows the baseline: it changes what the list covers.
  // Design state, Figma link and QA hand-off happen after the list is agreed.
  const editable = mayEdit && listState.open && !superseded;
  const drawable = mayEdit && !superseded;
  const replacement = screen.superseded_by ? allScreens.find((s) => s.id === screen.superseded_by) : null;

  const mappedIds = new Set(scopeItems.map((s) => s.id));
  const mapOptions = mappable.filter((m) => !mappedIds.has(m.id));
  const linkedAssetIds = new Set(assets.map((a) => a.assetId));
  const assetPick = assetOptions.filter((a) => !linkedAssetIds.has(a.id)).map((a) => ({ id: a.id, label: `${a.kind.replace(/_/g, ' ')} · ${a.prompt.slice(0, 60)}${a.prompt.length > 60 ? '…' : ''}` }));

  const text = (v: string | null) => (v && v.trim().length > 0 ? <span className="whitespace-pre-wrap">{v}</span> : <span className="text-muted">Not recorded</span>);
  const flag = (on: boolean) => <Badge tone={on ? 'success' : 'neutral'}>{on ? 'Recorded' : 'Not recorded'}</Badge>;

  const sections = splitList(screen.required_sections);
  const dependencies = splitList(screen.dependencies);
  const deviceTargets = screen.device_targets ?? [];
  const components = screen.components ?? [];
  const coverage = coverageOf(deviceTargets, screen.responsive_coverage);
  const coverageMap = (screen.responsive_coverage && typeof screen.responsive_coverage === 'object' ? screen.responsive_coverage : {}) as Record<string, unknown>;
  const preview = assets.find((a) => a.imageBase64) ?? null;

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
          <Badge tone={screen.design_state === 'reviewed' ? 'success' : screen.design_state === 'not_started' ? 'neutral' : 'info'} dot={false}>
            {DESIGN_STATE_LABEL[screen.design_state] ?? humanize(screen.design_state)}
          </Badge>
          {screen.qa_status === 'submitted' ? <Badge tone="info" dot={false}>submitted for QA</Badge> : null}
        </div>
        <Link href={`/projects/${projectId}/design/screens`} className="text-[13px] text-muted underline hover:text-foreground">
          All screens
        </Link>
      </div>

      {superseded ? (
        <Callout tone="warning" title="This screen was merged or split away.">
          It stays as history and takes no further change.{' '}
          {replacement ? (
            <>
              Its replacement is{' '}
              <Link href={`/projects/${projectId}/design/screens/${replacement.id}`} className="underline">
                {replacement.name} ({replacement.screen_key})
              </Link>
              .
            </>
          ) : null}
        </Callout>
      ) : mayEdit && !listState.open ? (
        <Callout tone="info" title={`The screen list is closed: ${listState.closedBy}.`}>
          A finalized baseline is what was agreed. Draft the next baseline version from the Design overview to change what this screen covers; the database refuses that until then. Design state, the Figma link and QA hand-off stay open.
        </Callout>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <DetailPanel
            title="Definition"
            rows={[
              { label: 'Purpose', value: text(screen.purpose) },
              { label: 'User role', value: humanize(screen.user_role) },
              { label: 'Device targets', value: deviceTargets.length === 0 ? <span className="text-muted">Not recorded</span> : <span className="flex flex-wrap gap-1">{deviceTargets.map((d) => <Badge key={d} tone="neutral" dot={false}>{d}</Badge>)}</span> },
              { label: 'Responsive coverage', value: !coverage ? <span className="text-muted">No device targets</span> : <span className="flex flex-wrap items-center gap-1"><span className={coverage.covered === coverage.total ? 'text-success' : 'text-warning'}>{coverage.covered}/{coverage.total} covered</span>{deviceTargets.map((d) => <Badge key={d} tone={coverageMap[d] === true ? 'success' : 'neutral'} dot={false}>{d}</Badge>)}</span> },
              { label: 'Components', value: components.length === 0 ? <span className="text-muted">Not recorded</span> : <span className="flex flex-wrap gap-1">{components.map((c) => <Badge key={c} tone="neutral" dot={false}>{c}</Badge>)}</span> },
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

          <Card>
            <CardHeader
              title={`Requirements it covers (${scopeItems.length})`}
              description="The scope items this screen is mapped to (screen_scope_items). An excluded item is refused by the database (Doc 12 §20); an unmapped screen is flagged on the Design overview."
            />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {scopeItems.length === 0 ? (
                <p className="text-[13px] text-muted">This screen is not mapped to any scope item — the coverage report on the Design overview flags it.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {scopeItems.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                      <span>
                        {s.title} <span className="text-muted">({s.inclusion}{s.scopeVersion !== null ? `, baseline v${s.scopeVersion}` : ''})</span>
                      </span>
                      {editable ? <UnmapScopeItemForm projectId={projectId} screenId={screen.id} scopeItemId={s.id} /> : null}
                    </li>
                  ))}
                </ul>
              )}
              {editable ? <MapScopeItemForm projectId={projectId} screenId={screen.id} options={mapOptions} /> : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Design preview" description="The linked asset's image where one exists; otherwise the Figma frame. A screen with neither says so." />
            <div className="px-4 pb-4 sm:px-5">
              {preview ? (
                <img src={`data:${preview.mediaType};base64,${preview.imageBase64}`} alt={preview.prompt ?? screen.name} className="max-h-96 w-auto rounded-lg border border-line" />
              ) : screen.figma_url ? (
                <a href={screen.figma_url} target="_blank" rel="noreferrer" className="text-[13px] underline hover:text-foreground">
                  Open the Figma frame
                </a>
              ) : (
                <p className="text-[13px] text-muted">No preview: no asset with an image is linked and no Figma frame is attached.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title={`Assets (${assets.length})`} description="Reference imagery linked to this screen (SCR-038). Optional support for the design, never the canonical artifact." />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {assets.length === 0 ? (
                <p className="text-[13px] text-muted">No reference asset is linked to this screen.</p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {assets.map((a) => (
                    <li key={a.linkId} className="flex flex-col gap-1.5 text-[13px]">
                      {a.imageBase64 ? (
                        <img src={`data:${a.mediaType};base64,${a.imageBase64}`} alt={a.prompt ?? 'design asset'} className="w-full rounded-lg border border-line" />
                      ) : (
                        <Link href={`/projects/${projectId}/design#design-assets`} className="rounded-lg border border-line px-3 py-6 text-center text-xs underline">
                          Uploaded asset — view it on the Design overview
                        </Link>
                      )}
                      <span className="flex items-center justify-between gap-2">
                        <Badge tone="neutral">{a.kind.replace(/_/g, ' ')}</Badge>
                        {mayEdit ? <UnlinkAssetForm projectId={projectId} linkId={a.linkId} screenId={screen.id} /> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {mayEdit && !superseded ? <LinkAssetForm projectId={projectId} fixedTarget={`screen:${screen.id}`} assets={assetPick} /> : null}
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {drawable ? (
            <Card>
              <CardHeader title="Design" description="Where the drawing stands, the Figma frame, and the hand-off to QA. Not bound to the baseline: these happen after the list is agreed." />
              <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Design state</span>
                  <DesignStateForm projectId={projectId} screenId={screen.id} current={screen.design_state} />
                </div>
                <FigmaUrlForm projectId={projectId} screenId={screen.id} current={screen.figma_url} />
                <SubmitForQaForm projectId={projectId} screenId={screen.id} submitted={screen.qa_status === 'submitted'} hasDraftPlan={testPlan?.status === 'draft'} />
              </div>
            </Card>
          ) : null}

          {drawable ? (
            <Card>
              <CardHeader title="States and fields" description="Add or remove a state after creation, and keep the role, device targets, components and responsive coverage current (SCR-035). Audited with before and after." />
              <div className="px-4 pb-4 sm:px-5">
                <ScreenStatesPanel
                  projectId={projectId}
                  screenId={screen.id}
                  current={{
                    hasEmptyState: screen.has_empty_state,
                    hasLoadingState: screen.has_loading_state,
                    hasErrorState: screen.has_error_state,
                    hasSuccessState: screen.has_success_state,
                    userRole: screen.user_role,
                    deviceTargets,
                    components,
                    responsiveCoverage: coverageMap,
                  }}
                />
              </div>
            </Card>
          ) : (
            <DetailPanel
              title="States"
              rows={[
                { label: 'Empty state', value: flag(screen.has_empty_state) },
                { label: 'Error state', value: flag(screen.has_error_state) },
                { label: 'Loading state', value: flag(screen.has_loading_state) },
                { label: 'Success state', value: flag(screen.has_success_state) },
              ]}
            />
          )}
          <DetailPanel
            title="Record"
            rows={[
              { label: 'Screen', value: screen.name },
              { label: 'Key', value: <span className="font-mono text-xs">{screen.screen_key}</span> },
              { label: 'Status', value: <StatusBadge status={screen.status} dot={false} /> },
              { label: 'Design state', value: DESIGN_STATE_LABEL[screen.design_state] ?? humanize(screen.design_state) },
              {
                label: 'Figma',
                value: screen.figma_url ? (
                  <a href={screen.figma_url} target="_blank" rel="noreferrer" className="break-all underline hover:text-foreground">
                    {screen.figma_url}
                  </a>
                ) : (
                  <span className="text-muted">No link attached</span>
                ),
              },
              { label: 'QA', value: screen.qa_status === 'submitted' ? 'Submitted' : <span className="text-muted">Not submitted</span> },
              { label: 'Baseline version', value: screen.baseline_version === null ? <span className="text-muted">Not in a baseline</span> : `v${screen.baseline_version}` },
              { label: 'Superseded by', value: replacement ? `${replacement.name} (${replacement.screen_key})` : <span className="text-muted">—</span> },
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
