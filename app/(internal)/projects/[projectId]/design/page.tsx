import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getProject,
  listDeliverables,
  listInternalRoster,
  readDesignTrail,
  readProjectSpend,
  readSampleScreens,
  readUiCoverage,
} from '@/modules/projects/queries';
import { describeDesignAction, readDesignActivity } from '@/modules/projects/design-activity-queries';
import { readDesignAssetVersions } from '@/modules/projects/design-asset-queries';
import {
  ActivityFeed,
  Badge,
  buttonClass,
  inputClass,
  Card,
  CardHeader,
  cx,
  DetailPanel,
  humanize,
  IconAlert,
  IconCheck,
  IconClock,
  IconFile,
  IconPalette,
  IconPlus,
  IconSparkle,
  IconUpload,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  statusTone,
  ViewAll,
} from '@/ui';

import { listDesignAssetLinks, listUiVersionOptions } from '@/modules/projects/screen-edit-queries';
import { assetMatches, recentFeedback } from '@/modules/projects/design-feedback';
import { listUiVersionFeedback } from '@/modules/projects/prototype-queries';
import { listProjectScreens } from '@/modules/projects/screens-queries';

import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';
import { LinkAssetForm, UnlinkAssetForm } from './asset-link-forms';
import { ApproveAssetButton, SubmitDesignReviewPanel, UploadDesignAssetPanel } from './design-asset-panels';
import { DesignCommentThread } from './design-comment-thread';
import { DesignSubNav } from './design-subnav';
import { readDesignReviewComments, type DesignReviewComment } from '@/modules/projects/design-review-comments-queries';
import { AssignReviewerForm, ResolveStopForm } from './design-forms';
import { Nothing, PHASE_TONE, Section, when } from './design-shared';

export const metadata: Metadata = { title: 'Design direction' };

/**
 * The Design Dashboard — SCR-032, laid out as the reference: figures, the
 * screen gallery, the theme options, and a rail with the project details,
 * the design progress and the reference imagery. The gallery tiles are the
 * representative screens Phase 3 recorded (`projects.representative_screens`),
 * drawn from their stored `preview_asset_url` when one exists and as a
 * named placeholder when it does not — a screen with no preview says so
 * rather than showing a stock image. Figma stays the canonical design;
 * every tile links to the theme it belongs to.
 *
 * Bucket F (migration 20261001130000) added what the element audit found
 * missing on this screen: the approved counts as real tiles, the design
 * versions list with "submit for review" through the deliverable's own
 * door, the prototype links, the upload of a design asset into storage
 * (bucket E's), the asset lifecycle (draft → approved, versions), and the
 * recent activity feed read from the audit rows of every design subject.
 *
 * Master §8's decision trail (themes, colours, review queues, the client
 * loop and the final lock) stays on the tabs below; every write still goes
 * through `design-forms.tsx` or the new asset panels.
 */
type DeliverableRow = Awaited<ReturnType<typeof listDeliverables>>[number];
type UiVersionOption = Awaited<ReturnType<typeof listUiVersionOptions>>[number];

function DesignVersionsCard({ projectId, designVersions, draftDesign, mayDecide, clock, comments }: { projectId: string; designVersions: DeliverableRow[]; draftDesign: DeliverableRow | null; mayDecide: boolean; clock: Awaited<ReturnType<typeof agencyClock>>; comments: Map<string, DesignReviewComment[]> }) {
  return (
      <Card id="design-versions" className="scroll-mt-4">
        <CardHeader title={`Design Versions (${designVersions.length})`} description="Every design deliverable recorded, newest first, with its review state." actions={<ViewAll href={`/projects/${projectId}`} label="Overview" />} />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {designVersions.length === 0 ? (
            <Nothing>No design version has been recorded as a deliverable yet.</Nothing>
          ) : (
            <ul className="flex flex-col gap-1">
              {designVersions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-medium">v{d.version}</span>
                    <span className="truncate">{d.title}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
                    {d.artifact_url ? (
                      <a href={d.artifact_url} target="_blank" rel="noreferrer noopener" className="text-xs underline underline-offset-2">
                        open
                      </a>
                    ) : null}
                    <span className="text-xs text-muted">{clock.date(d.created_at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {designVersions.filter((d) => d.status === 'in_review' || (comments.get(d.id)?.length ?? 0) > 0).map((d) => (
            <div key={`thread-${d.id}`} className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Review of v{d.version} — {d.title}</span>
              <DesignCommentThread projectId={projectId} subjectType="deliverable" subjectId={d.id} comments={comments.get(d.id) ?? []} canComment={mayDecide} formatDateTime={(iso) => clock.dateTime(iso)} />
            </div>
          ))}
          {mayDecide ? <SubmitDesignReviewPanel projectId={projectId} deliverable={draftDesign ? { id: draftDesign.id, version: draftDesign.version, title: draftDesign.title } : null} /> : null}
        </div>
      </Card>
  );
}

function PrototypeLinksCard({ projectId, prototypeVersions, uiVersions }: { projectId: string; prototypeVersions: DeliverableRow[]; uiVersions: UiVersionOption[] }) {
  return (
      <Card>
        <CardHeader title={`Prototype Links (${prototypeVersions.length})`} description="The prototype builds and the UI versions they were built from." actions={<ViewAll href={`/projects/${projectId}/prototype`} label="Prototype" />} />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {prototypeVersions.length === 0 && uiVersions.length === 0 ? (
            <Nothing>No prototype build or UI version yet. They appear once Phase 4 drafts one.</Nothing>
          ) : (
            <ul className="flex flex-col gap-1">
              {prototypeVersions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <Link href={`/projects/${projectId}/prototype`} className="font-medium underline-offset-2 hover:underline">
                    Prototype v{d.version} — {d.title}
                  </Link>
                  <span className="flex items-center gap-2">
                    <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
                    {d.artifact_url ? (
                      <a href={d.artifact_url} target="_blank" rel="noreferrer noopener" className="text-xs underline underline-offset-2">
                        open
                      </a>
                    ) : null}
                  </span>
                </li>
              ))}
              {uiVersions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <Link href={`/projects/${projectId}/prototype/preview/${v.id}`} className="underline-offset-2 hover:underline">
                    UI version {v.version} preview
                  </Link>
                  <Badge tone={statusTone(v.status)}>{humanize(v.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
  );
}

export default async function ProjectDesignPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ q?: string; view?: string; layout?: string; assetQ?: string }> }) {
  const { projectId } = await params;
  const { q: qRaw, view: viewRaw, layout: layoutRaw, assetQ: assetQRaw } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/design`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  // The trail and the roster together — two reads, one moment (G-287).
  const [trail, roster] = await Promise.all([readDesignTrail(projectId), listInternalRoster()]);
  const [clock, clientName] = await Promise.all([agencyClock(), project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null)]);
  const { phase } = trail;
  const mayDecide = can(context, 'project.write');

  if (!phase) {
    // Phase 3 has no record for this project — it may not have started, or the project may have been built without it
    // and be in a later phase. The design deliverables and prototype builds the project does have must stay reachable.
    const [deliverablesNoPhase, uiVersionsNoPhase, deliverableCommentsNoPhase] = await Promise.all([listDeliverables(projectId), listUiVersionOptions(projectId), readDesignReviewComments(projectId)]);
    const designs = deliverablesNoPhase.filter((d) => d.kind === 'design');
    const prototypes = deliverablesNoPhase.filter((d) => d.kind === 'prototype');
    const laterPhase = designs.length > 0 || prototypes.length > 0 || uiVersionsNoPhase.length > 0;
    return (
      <div className="flex flex-col gap-5">
        <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayDecide} />
        <ProjectSubNav projectId={projectId} />
        <DesignSubNav projectId={projectId} />
        <Nothing>
          {laterPhase
            ? 'This project has no Phase 3 record (no theme options, baseline or asset library), but it already has design or prototype work, shown below.'
            : 'Phase 3 has not started for this project. It opens when Phase 2 completes and the plan is active.'}{' '}
          <Link href={`/projects/${projectId}/plan`} className="underline hover:text-foreground">
            Open the plan
          </Link>
          .
        </Nothing>
        {laterPhase ? (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <DesignVersionsCard projectId={projectId} designVersions={designs} draftDesign={designs.find((d) => d.status === 'draft') ?? null} mayDecide={mayDecide} clock={clock} comments={deliverableCommentsNoPhase} />
            <PrototypeLinksCard projectId={projectId} prototypeVersions={prototypes} uiVersions={uiVersionsNoPhase} />
          </div>
        ) : null}
      </div>
    );
  }

  const spend = await readProjectSpend(projectId);
  const screenCoverage = await readUiCoverage(projectId);
  const [assetLibrary, sampleScreens, assetLinks, uiVersions, inventory, deliverables, activity, deliverableComments, uiFeedback] = await Promise.all([
    readDesignAssetVersions(projectId, context.organizationId ?? null),
    readSampleScreens(projectId, trail.themes.map((t) => t.id)),
    listDesignAssetLinks(projectId),
    listUiVersionOptions(projectId),
    listProjectScreens(projectId),
    listDeliverables(projectId),
    readDesignActivity(projectId, 20),
    readDesignReviewComments(projectId),
    listUiVersionFeedback(projectId, 10),
  ]);
  // SCR-038 — where an asset may be linked: every live screen and every UI version.
  const linkTargets = [
    ...inventory.filter((s) => s.status !== 'superseded').map((s) => ({ value: `screen:${s.id}`, label: `Screen · ${s.name} (${s.screen_key})` })),
    ...uiVersions.map((v) => ({ value: `ui_version:${v.id}`, label: `UI version ${v.version} · ${humanize(v.status)}` })),
  ];

  const reviewerName = phase.reviewerUserId ? (roster.find((r) => r.userId === phase.reviewerUserId)?.fullName ?? null) : null;
  const pendingInternal = trail.themes.filter((t) => t.internalReviewStatus === 'pending').length;
  const pendingAdmin = trail.themes.filter((t) => t.adminStatus === 'pending').length;
  const clientDecision = trail.clientDecisions[0] ?? null;
  // SCR-038 — recent feedback, each answer tied to the exact version it was about (the share's snapshot, or the UI version).
  const feedback = recentFeedback({
    decisions: trail.clientDecisions,
    shares: trail.shares,
    themes: trail.themes.map((t) => ({ id: t.id, name: t.name, version: t.version })),
    uiDecisions: uiFeedback,
    limit: 5,
  });
  const assetQuery = (assetQRaw ?? '').trim().slice(0, 80);
  const withPreview = sampleScreens.samples.filter((s) => s.previewAssetUrl).length;

  // SCR-032 — the counts as counts: screens approved, assets approved,
  // design versions, prototype builds. Each tile opens the list behind it.
  const liveScreens = inventory.filter((s) => s.status !== 'superseded');
  const approvedScreens = liveScreens.filter((s) => s.status === 'approved').length;
  const designedScreens = liveScreens.filter((s) => s.design_state === 'drawn' || s.design_state === 'reviewed').length;
  const latestUiVersion = uiVersions[0] ?? null;
  const designVersions = deliverables.filter((d) => d.kind === 'design');
  const prototypeVersions = deliverables.filter((d) => d.kind === 'prototype');
  // The All Screens views: the project's own screen inventory, split by review state.
  // Completed = approved; In Progress = in review; Pending = draft or blocked.
  const SCREEN_VIEWS = { all: 'All Screens', completed: 'Completed', progress: 'In Progress', pending: 'Pending' } as const;
  type ScreenView = keyof typeof SCREEN_VIEWS;
  const inView = (view: ScreenView, status: string) => (view === 'all' ? true : view === 'completed' ? status === 'approved' : view === 'progress' ? status === 'in_review' : status === 'draft' || status === 'blocked');
  const screenView: ScreenView = viewRaw && viewRaw in SCREEN_VIEWS ? (viewRaw as ScreenView) : 'all';
  const screenQuery = (qRaw ?? '').trim().slice(0, 80);
  const screenLayout = layoutRaw === 'list' ? 'list' : 'grid';
  const shownScreens = liveScreens.filter((sc) => inView(screenView, sc.status) && (!screenQuery || `${sc.name} ${sc.screen_key}`.toLowerCase().includes(screenQuery.toLowerCase())));
  const previewByName = new Map(sampleScreens.samples.filter((sm) => sm.previewAssetUrl).map((sm) => [sm.screenName.toLowerCase(), sm.previewAssetUrl as string]));
  const screenHref = (over: { view?: ScreenView; layout?: string }) => {
    const qs = new URLSearchParams();
    const v = over.view ?? screenView;
    const l = over.layout ?? screenLayout;
    if (v !== 'all') qs.set('view', v);
    if (screenQuery) qs.set('q', screenQuery);
    if (l !== 'grid') qs.set('layout', l);
    return `/projects/${projectId}/design${qs.size > 0 ? `?${qs.toString()}` : ''}`;
  };
  const draftDesign = designVersions.find((d) => d.status === 'draft') ?? null;

  const steps: { label: string; state: 'done' | 'current' | 'upcoming'; caption?: string }[] = [
    { label: 'Screen list finalized', state: trail.baseline?.status === 'finalized' ? 'done' : trail.baseline ? 'current' : 'upcoming', caption: trail.baseline ? `v${trail.baseline.version} · ${trail.baseline.screenCount} screens` : undefined },
    { label: 'Theme options drafted', state: trail.themes.length > 0 ? 'done' : trail.baseline?.status === 'finalized' ? 'current' : 'upcoming', caption: trail.themes.length > 0 ? `${trail.themes.length} option${trail.themes.length === 1 ? '' : 's'}` : undefined },
    { label: 'Internal review', state: trail.themes.length > 0 && pendingInternal === 0 ? 'done' : trail.themes.length > 0 ? 'current' : 'upcoming', caption: pendingInternal > 0 ? `${pendingInternal} waiting` : undefined },
    { label: 'Admin approval', state: trail.themes.length > 0 && pendingAdmin === 0 && pendingInternal === 0 ? 'done' : pendingInternal === 0 && trail.themes.length > 0 ? 'current' : 'upcoming', caption: pendingAdmin > 0 ? `${pendingAdmin} waiting` : undefined },
    { label: 'Client decision', state: clientDecision ? 'done' : trail.shares.length > 0 ? 'current' : 'upcoming', caption: clientDecision ? humanize(clientDecision.decision) : trail.shares.length > 0 ? `Shared ${trail.shares.length}×` : undefined },
    { label: 'Locked for Phase 4', state: trail.handoff ? 'done' : clientDecision ? 'current' : 'upcoming', caption: trail.handoff ? `Locked ${when(trail.handoff.lockedAt)}` : undefined },
  ];
  const doneSteps = steps.filter((s) => s.state === 'done').length;

  const activityItems = activity.map((a) => ({
    id: String(a.id),
    title: describeDesignAction(a.action),
    detail: `${a.actorName ?? (a.actorType === 'user' ? 'a person' : a.actorType)} · ${a.subjectType.replace(/_/g, ' ')}`,
    when: clock.dateTime(a.createdAt),
    tone: (a.action.endsWith('approved') || a.action.endsWith('locked') || a.action.endsWith('finalized') ? 'success' : 'neutral') as 'success' | 'neutral',
  }));

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayDecide} />
      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <StatGrid cols={5}>
        <Stat label="Total Screens" value={String(trail.baseline?.screenCount ?? 0)} caption={trail.baseline ? `Baseline v${trail.baseline.version} · ${trail.baseline.status}` : 'No baseline drafted'} tone="brand" icon={<IconFile size={16} />} ring={liveScreens.length > 0 ? { percent: (approvedScreens / liveScreens.length) * 100, label: 'of live screens approved' } : undefined} href={`/projects/${projectId}/design/screens`} />
        {/* SCR-032 "Total screens/designed/approved": designed = drawn or reviewed in Figma (the design state each screen carries). */}
        <Stat label="Designed Screens" value={String(designedScreens)} caption={liveScreens.length > 0 ? `of ${liveScreens.length} live · ${liveScreens.length - designedScreens} not yet` : 'None recorded'} tone={liveScreens.length > 0 && designedScreens === liveScreens.length ? 'success' : 'info'} icon={<IconPalette size={16} />} href={`/projects/${projectId}/design/screens`} />
        <Stat label="Approved Screens" value={String(approvedScreens)} caption={liveScreens.length > 0 ? `of ${liveScreens.length} live` : 'None recorded'} tone={liveScreens.length > 0 && approvedScreens === liveScreens.length ? 'success' : 'info'} icon={<IconCheck size={16} />} href={`/projects/${projectId}/design/screens?status=approved`} />
        <Stat label="Approved Assets" value={String(assetLibrary.approved)} caption={`${assetLibrary.draft} draft · ${assetLibrary.uploaded} uploaded`} tone={assetLibrary.approved > 0 ? 'success' : 'neutral'} icon={<IconUpload size={16} />} href="#design-assets" />
        <Stat label="Theme Options" value={String(trail.themes.length)} caption={trail.themes.length > 0 ? `${trail.themes.filter((t) => t.clientStatus === 'selected').length} selected by the client` : undefined} tone="accent" icon={<IconSparkle size={16} />} ring={trail.themes.length > 0 ? { percent: (trail.themes.filter((t) => t.clientStatus === 'selected').length / trail.themes.length) * 100, label: 'of theme options selected by the client' } : undefined} href={`/projects/${projectId}/design/themes`} />
        <Stat label="Design Versions" value={String(designVersions.length)} caption={`${designVersions.filter((d) => d.status === 'in_review').length} in review · ${designVersions.filter((d) => d.status === 'approved').length} approved`} tone="brand" icon={<IconFile size={16} />} href="#design-versions" />
        <Stat label="Prototype Builds" value={String(prototypeVersions.length)} caption={`${prototypeVersions.filter((d) => d.status === 'in_review').length} with the client · ${prototypeVersions.filter((d) => d.status === 'approved').length} approved`} tone="accent" icon={<IconSparkle size={16} />} href={`/projects/${projectId}/prototype`} />
        <Stat label="Pending Review" value={String(pendingInternal + pendingAdmin)} caption={`${pendingInternal} internal · ${pendingAdmin} admin`} tone={pendingInternal + pendingAdmin > 0 ? 'warning' : 'success'} icon={<IconClock size={16} />} href={`/projects/${projectId}/design/themes`} />
        {/* SCR-032 "UI status": where the latest Phase 4 UI version stands (draft, in review, approved...). */}
        <Stat label="UI Status" value={latestUiVersion ? humanize(latestUiVersion.status) : 'Not started'} caption={latestUiVersion ? `UI v${latestUiVersion.version} of ${uiVersions.length}` : 'No UI version yet'} tone={latestUiVersion?.status === 'approved' ? 'success' : latestUiVersion ? 'info' : 'neutral'} icon={<IconSparkle size={16} />} href={latestUiVersion ? `/projects/${projectId}/ui-versions/${latestUiVersion.id}` : `/projects/${projectId}/prototype`} />
        <Stat label="Phase Status" value={humanize(phase.state)} caption={phase.blockedReason ? 'Blocked' : trail.handoff ? 'Handed to Phase 4' : `Started ${when(phase.startedAt)}`} tone={phase.blockedReason ? 'danger' : trail.handoff ? 'success' : 'info'} icon={phase.blockedReason ? <IconAlert size={16} /> : <IconCheck size={16} />} />
      </StatGrid>

      {/* §8 — Phase 3 Overview. The counts are printed as stored and never
          compared here: the ceiling is the database's rule, and this page
          takes no decision of its own: comparing them here would be a second opinion on a rule the database already holds. */}
      <div className="grid gap-4 lg:grid-cols-2 [&>section]:rounded-xl [&>section]:border [&>section]:border-line [&>section]:bg-surface [&>section]:p-4 [&>section]:shadow-xs sm:[&>section]:p-5">
        <Section title="Overview">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={PHASE_TONE[phase.state] ?? 'neutral'}>{phase.state.replace(/_/g, ' ')}</Badge>
            <span className="text-[13px] text-muted">
              started {when(phase.startedAt)}
              {phase.completedAt ? ` · completed ${when(phase.completedAt)}` : ''}
            </span>
            <span className="text-[13px] text-muted">· {phase.revisionCount} of {phase.revisionLimit} client revision rounds used · {`${sampleScreens.samples.length} sample screens, ${withPreview} with a preview`}</span>
          </div>
          {phase.blockedReason ? <p className="max-w-2xl rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">{phase.blockedReason}</p> : null}
          {['scope_escalation', 'revision_limit_escalation', 'blocked_requirement'].includes(phase.state) && can(context, 'audit.read') ? (
            <ResolveStopForm projectId={projectId} phaseThreeId={phase.id} state={phase.state} />
          ) : null}
          {!phase.reviewerUserId ? <Nothing>No internal design reviewer is assigned. The internal gate refuses until somebody holds it, and nothing reaches Admin until it passes.</Nothing> : null}
        </Section>
        <Section title="Screen baseline" hint="The screen list and its content baseline, as finalized. A later change is a new version.">
          {!trail.baseline ? (
            <Nothing>No screen baseline has been drafted.</Nothing>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={trail.baseline.status === 'finalized' ? 'success' : 'neutral'}>
                v{trail.baseline.version} · {trail.baseline.status}
              </Badge>
              <span className="text-[13px] text-muted">{trail.baseline.screenCount} screens</span>
              <Link href={`/projects/${projectId}/plan`} className="text-[13px] underline hover:text-foreground">
                the plan it was built from
              </Link>
              {/* SCR-034 — the inventory as a sheet: every screen, every column, its scope mapping. */}
              <a href={`/api/projects/${projectId}/design/screens/export`} className="text-[13px] underline hover:text-foreground">
                export the inventory (CSV)
              </a>
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader
              title={`Screens (${shownScreens.length}/${liveScreens.length})`}
              description="The project's screen inventory. Figma is the canonical design; a preview is a reference."
              actions={<ViewAll href={`/projects/${projectId}/design/screens`} label="Inventory" />}
            />
            <nav aria-label="Screen views" className="flex flex-wrap gap-1 px-4 sm:px-5">
              {(Object.keys(SCREEN_VIEWS) as ScreenView[]).map((v) => (
                <Link
                  key={v}
                  href={screenHref({ view: v })}
                  aria-current={screenView === v ? 'page' : undefined}
                  className={cx('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium', screenView === v ? 'border-brand/40 bg-brand-soft text-brand' : 'border-transparent text-muted hover:bg-surface-hover')}
                >
                  {SCREEN_VIEWS[v]}
                  <span className="tabular rounded-full bg-surface px-1.5 text-[11px]">{liveScreens.filter((sc) => inView(v, sc.status)).length}</span>
                </Link>
              ))}
            </nav>
            <form method="get" action={`/projects/${projectId}/design`} className="flex flex-wrap items-center gap-2 px-4 pt-3 sm:px-5">
              {screenView !== 'all' ? <input type="hidden" name="view" value={screenView} /> : null}
              {screenLayout === 'list' ? <input type="hidden" name="layout" value="list" /> : null}
              <input name="q" defaultValue={screenQuery} placeholder="Search screens by name…" aria-label="Search screens" className={cx(inputClass, 'min-w-[12rem] flex-1')} />
              <button type="submit" className={buttonClass('secondary', 'sm')}>Search</button>
              {screenQuery ? <Link href={screenHref({})} className="text-xs text-muted hover:underline" prefetch={false}>Clear</Link> : null}
              <span className="ml-auto flex gap-1" role="group" aria-label="Layout">
                <Link href={screenHref({ layout: 'grid' })} aria-current={screenLayout === 'grid' ? 'true' : undefined} className={buttonClass(screenLayout === 'grid' ? 'primary' : 'secondary', 'sm')}>Grid</Link>
                <Link href={screenHref({ layout: 'list' })} aria-current={screenLayout === 'list' ? 'true' : undefined} className={buttonClass(screenLayout === 'list' ? 'primary' : 'secondary', 'sm')}>List</Link>
              </span>
              {mayDecide ? (
                <Link href={`/projects/${projectId}/design/screens`} className={buttonClass('primary', 'sm')}>
                  <IconPlus size={14} /> Add Screen
                </Link>
              ) : null}
            </form>
            {shownScreens.length === 0 ? (
              <div className="p-4 sm:p-5">
                <Nothing>{liveScreens.length === 0 ? 'No screen has been recorded for this project yet.' : 'No screen matches this view.'}</Nothing>
              </div>
            ) : screenLayout === 'list' ? (
              <ul className="divide-y divide-line px-4 pb-2 pt-2 sm:px-5">
                {shownScreens.map((sc, i) => (
                  <li key={sc.id} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                    <Link href={`/projects/${projectId}/design/screens/${sc.id}`} className="min-w-0 truncate font-medium hover:text-brand">{i + 1}. {sc.name}</Link>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="font-mono text-[11px] text-muted">{sc.screen_key}</span>
                      <StatusBadge status={sc.status} dot={false} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4 sm:p-5">
                {shownScreens.map((sc, i) => {
                  const preview = previewByName.get(sc.name.toLowerCase());
                  return (
                    <li key={sc.id} className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
                      <Link href={`/projects/${projectId}/design/screens/${sc.id}`} className="block">
                        {preview ? (
                          // A stored preview URL from the design trail — not optimised, not ours to resize.
                          <img src={preview} alt={`${sc.name} preview`} className="aspect-[9/16] w-full bg-sidebar-bg object-cover" loading="lazy" />
                        ) : (
                          <span className="flex aspect-[9/16] w-full flex-col items-center justify-center gap-1 bg-sidebar-bg px-3 text-center text-sidebar-fg">
                            <IconPalette size={22} className="text-sidebar-muted" />
                            <span className="text-[13px] font-semibold">{sc.name}</span>
                            <span className="text-[11px] text-sidebar-muted">No preview stored</span>
                          </span>
                        )}
                      </Link>
                      <div className="flex flex-col gap-1 p-2.5">
                        <span className="truncate text-[13px] font-medium text-foreground">{i + 1}. {sc.name}</span>
                        <span className="truncate text-[11px] text-muted">{humanize(sc.design_state)}</span>
                        <StatusBadge status={sc.status} dot={false} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Theme Options" actions={<ViewAll href={`/projects/${projectId}/design/themes`} />} />
            {trail.themes.length === 0 ? (
              <div className="px-4 pb-4 sm:px-5">
                <Nothing>No theme option has been drafted.</Nothing>
              </div>
            ) : (
              <ul className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3">
                {trail.themes.map((t) => (
                  <li key={t.id} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                    {t.previewAssetUrl ? (
                      <img src={t.previewAssetUrl} alt={`${t.name} preview`} className="aspect-video w-full rounded-lg bg-sidebar-bg object-cover" loading="lazy" />
                    ) : (
                      <span className="flex aspect-video w-full items-center justify-center rounded-lg bg-surface-sunken text-xs text-muted">No preview</span>
                    )}
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium">
                        {t.optionIndex + 1}. {t.name}
                      </span>
                      <Badge tone="neutral">v{t.version}</Badge>
                    </span>
                    <span className="line-clamp-2 text-xs text-muted">{t.directionSummary}</span>
                    <span className="flex flex-wrap gap-1">
                      <StatusBadge status={t.internalReviewStatus} dot={false} />
                      <StatusBadge status={t.adminStatus} dot={false} />
                      <StatusBadge status={t.clientStatus} dot={false} />
                    </span>
                    {t.colors.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {t.colors.flatMap((c) => c.swatches.slice(0, 5)).map((hex, i) => (
                          <span key={`${hex}-${i}`} aria-hidden className="h-4 w-4 rounded-full ring-1 ring-inset ring-line" style={{ background: hex }} title={hex} />
                        ))}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* SCR-032 — Design versions and Prototype links. The versions are
              `projects.deliverables` of kind design/prototype, the same rows
              the Overview tab lists; "submit for review" is that row's own
              door and nothing else. */}
          <div className="flex flex-col gap-4 [&>section]:rounded-xl [&>section]:border [&>section]:border-line [&>section]:bg-surface [&>section]:p-4 [&>section]:shadow-xs sm:[&>section]:p-5">
            {/*
              Doc 12 §9 and §20 — the coverage matrix. A REPORT, and deliberately
              not a second gate: `projects.refuse_uncovered_design` already refuses
              the three flags that are mechanically exact, and the rest are
              judgement nobody has configured. Surfacing them is the control; adding
              a threshold here would be inventing the business rule.
            */}
            <Section
              title="Screen Coverage"
              hint="Doc 12 §9. Blocking flags are the three the database refuses a design against; the rest are for a person to weigh.">
              {screenCoverage.length === 0 ? (
                <Nothing>Nothing is flagged. Every included scope item has a screen, and every screen has what §9 asks of it.</Nothing>
              ) : (
                <ul className="flex flex-col gap-1">
                  {screenCoverage.map((flag) => (
                    <li key={`${flag.flag}:${flag.subject_id}`} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line p-3 text-[13px]">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{flag.subject}</span> <span className="text-muted">— {flag.flag.replace(/_/g, ' ')}</span>
                      </span>
                      {flag.blocking ? <Badge tone="danger">refused by the database</Badge> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Cost and Usage">
              {spend.length === 0 ? (
                <Nothing>No agent run has been attributed to this project yet. When a design agent runs, its usage is recorded against the project like every other run.</Nothing>
              ) : (
                <table className="w-full max-w-2xl text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="py-1 font-normal">Phase</th>
                      <th className="py-1 font-normal">Runs</th>
                      <th className="py-1 font-normal">In</th>
                      <th className="py-1 font-normal">Out</th>
                      <th className="py-1 font-normal">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spend.map((row) => (
                      <tr key={row.phase ?? 'unattributed'} className="border-b border-line">
                        <td className="py-1">
                          {row.phase === null ? (
                            <span className="text-muted">phase not knowable</span>
                          ) : (
                            `Phase ${row.phase}`
                          )}
                        </td>
                        <td className="py-1">{row.runs}</td>
                        <td className="py-1">{row.inputTokens.toLocaleString('en-IN')}</td>
                        <td className="py-1">{row.outputTokens.toLocaleString('en-IN')}</td>
                        {/* Minor units, like every other money column in this system. */}
                        <td className="py-1">₹{(row.costMinor / 100).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {spend.some((r) => r.phase === null) ? (
                <p className="max-w-2xl text-xs text-muted">
                  A run whose phase is not knowable is still this project’s spend — dropping it would understate the total, and
                  understating spend is the direction that matters. Phase is recorded only
                  where a run’s subject belongs to exactly one phase — guessing would make this table
                  confidently wrong.
                </p>
              ) : null}
            </Section>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <DetailPanel
            title="Project Details"
            rows={[
              { label: 'Project', value: project.name },
              { label: 'Client', value: clientName ?? 'Internal project' },
              { label: 'Phase', value: <Badge tone={PHASE_TONE[phase.state] ?? 'neutral'}>{phase.state.replace(/_/g, ' ')}</Badge> },
              { label: 'Started', value: when(phase.startedAt) },
              ...(phase.completedAt ? [{ label: 'Completed', value: when(phase.completedAt) }] : []),
              { label: 'Design reviewer', value: reviewerName ?? <span className="text-danger">Not assigned</span> },
              { label: 'Baseline', value: trail.baseline ? `v${trail.baseline.version} · ${trail.baseline.screenCount} screens` : 'None' },
            ]}
          >
            {mayDecide ? (
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <AssignReviewerForm projectId={projectId} roster={roster} current={phase.reviewerUserId} />
              </div>
            ) : null}
          </DetailPanel>

          <Card>
            <CardHeader title="Design Progress" actions={<ViewAll href={`/projects/${projectId}/design/final`} label="Final selection" />} />
            <div className="px-4 pb-2 sm:px-5">
              <ProgressBar value={(doneSteps / steps.length) * 100} label="Design steps complete" tone="brand" />
            </div>
            <ol className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
              {steps.map((s, i) => (
                <li key={s.label} className="flex items-start gap-3">
                  <span className={cx('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', s.state === 'done' ? 'bg-success text-white' : s.state === 'current' ? 'bg-brand text-white' : 'border border-line-strong text-muted')}>
                    {s.state === 'done' ? <IconCheck size={12} /> : i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className={cx('block text-[13px]', s.state === 'upcoming' ? 'text-muted' : 'font-medium text-foreground')}>{s.label}</span>
                    {s.caption ? <span className="block text-[11px] text-muted">{s.caption}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </Card>

          <Card>
            <CardHeader title="Client Review" />
            <dl className="grid grid-cols-[minmax(6rem,38%)_1fr] gap-x-3 gap-y-2 px-4 pb-4 text-[13px] sm:px-5">
              <dt className="text-muted">Status</dt>
              <dd className="font-medium">{clientDecision ? humanize(clientDecision.decision) : trail.shares.length > 0 ? `Shared ${trail.shares.length}×` : 'Not shared'}</dd>
              <dt className="text-muted">Shared on</dt>
              <dd className="font-medium">{trail.shares[0] ? when(trail.shares[0].createdAt) : '—'}</dd>
              <dt className="text-muted">Feedback</dt>
              <dd className="font-medium">{clientDecision ? clientDecision.clientWords : '—'}</dd>
            </dl>
          </Card>

          <Card id="recent-feedback">
            <CardHeader title="Recent Feedback" description="The latest client answers, each tied to the exact version it was about." actions={<ViewAll href={`/projects/${projectId}/design/final`} label="All feedback" />} />
            {feedback.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">The client has not replied on any design or prototype version yet.</p>
            ) : (
              <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
                {feedback.map((f) => (
                  <li key={f.id} className="flex flex-col gap-0.5 border-l-2 border-line pl-3 text-[13px]">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={f.decision === 'final_confirmed' ? 'success' : f.decision === 'possible_scope_change' ? 'danger' : 'info'}>{humanize(f.decision)}</Badge>
                      <span className="text-xs text-muted">{when(f.at)}</span>
                    </span>
                    <span className="text-xs text-muted">{f.kind === 'prototype' ? 'Prototype' : 'Design'} · {f.refersTo}</span>
                    <span className="line-clamp-3">“{f.words}”</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="scroll-mt-4" id="design-assets">
            <CardHeader
              title={`Design assets (${assetLibrary.families.length})`}
              description="Uploaded designs and AI-drawn reference imagery (Designer §9). Each has a state — draft until a person approves it — and versions. Figma stays the canonical design."
              actions={
                <span className="flex flex-wrap gap-3">
                  <a href={`/api/projects/${projectId}/design/assets/export?format=zip`} className="text-xs underline hover:text-foreground">
                    Handoff package (ZIP)
                  </a>
                  <a href={`/api/projects/${projectId}/design/assets/export`} className="text-xs underline hover:text-foreground">
                    Manifest (JSON)
                  </a>
                </span>
              }
            />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {/* SCR-038 — asset categories: how many assets of each kind, and where the brand kit lives. */}
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                {[...new Set(assetLibrary.families.map((f) => f.kind))].sort().map((k) => (
                  <Badge key={k} tone="neutral" dot={false}>
                    {k.replace(/_/g, ' ')} · {assetLibrary.families.filter((f) => f.kind === k).length}
                  </Badge>
                ))}
                <Link href={`/projects/${projectId}/design/brand`} className="underline hover:text-foreground">
                  Brand Kit
                </Link>
              </p>
              {assetLibrary.families.length > 0 ? (
                <form method="get" className="flex flex-wrap items-end gap-2" role="search" aria-label="Search design assets">
                  {viewRaw ? <input type="hidden" name="view" value={viewRaw} /> : null}
                  {qRaw ? <input type="hidden" name="q" value={qRaw} /> : null}
                  {layoutRaw ? <input type="hidden" name="layout" value={layoutRaw} /> : null}
                  <input name="assetQ" defaultValue={assetQuery} maxLength={80} placeholder="Search assets by title, kind or status…" aria-label="Search assets" className={cx(inputClass, 'min-w-[12rem] flex-1')} />
                  <button type="submit" className={buttonClass('secondary', 'sm')}>Search</button>
                  {assetQuery ? <Link href={screenHref({})} className="pb-2 text-xs underline hover:text-foreground">Clear</Link> : null}
                </form>
              ) : null}
              {mayDecide ? <UploadDesignAssetPanel projectId={projectId} storage={assetLibrary.storage} /> : null}
              {!assetLibrary.storage.reachable && assetLibrary.uploaded > 0 ? (
                <p className="text-xs text-warning">{assetLibrary.uploaded} uploaded asset{assetLibrary.uploaded === 1 ? '' : 's'} cannot be shown: {assetLibrary.storage.reason}</p>
              ) : null}
              {assetLibrary.families.length === 0 ? (
                <p className="text-[13px] text-muted">No design asset has been uploaded or generated for this project.</p>
              ) : (
                /*
                  SCR-038 — one folder per kind; each family is a first version and
                  its replacements. Where an asset is used is `design_asset_links`
                  (20260929200000): a screen or a UI version, linked and unlinked here.
                */
                <div className="flex flex-col gap-2">
                  {assetQuery && !assetLibrary.families.some((f) => assetMatches({ title: f.latest.title, kind: f.kind, status: f.latest.status, rightsNote: f.latest.rightsNote ?? null }, assetQuery)) ? (
                    <p className="text-[13px] text-muted">No asset matches “{assetQuery}”.</p>
                  ) : null}
                  {[...new Set(assetLibrary.families.map((f) => f.kind))].map((kind) => {
                    const folder = assetLibrary.families.filter((f) => f.kind === kind && assetMatches({ title: f.latest.title, kind: f.kind, status: f.latest.status, rightsNote: f.latest.rightsNote ?? null }, assetQuery));
                    if (folder.length === 0) return null;
                    return (
                      <details key={kind} open className="rounded-md border border-line">
                        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-[13px] font-medium">
                          {kind.replace(/_/g, ' ')}
                          <span className="text-xs font-normal text-muted">
                            {folder.length} asset{folder.length === 1 ? '' : 's'} · {folder.filter((f) => f.latest.status === 'approved').length} approved
                          </span>
                        </summary>
                        <ul className="flex flex-col gap-3 border-t border-line p-3">
                          {folder.map((family) => {
                            const asset = family.latest;
                            const links = assetLinks.filter((l) => family.versions.some((v) => v.id === l.assetId));
                            const taken = new Set(links.map((l) => (l.screenId ? `screen:${l.screenId}` : `ui_version:${l.uiVersionId}`)));
                            return (
                              <li key={family.familyId} className="flex flex-col gap-1.5 text-[13px]">
                                {asset.previewUrl ? (
                                  asset.mediaType === 'application/pdf' ? (
                                    <a href={asset.previewUrl} target="_blank" rel="noreferrer noopener" className="rounded-lg border border-line px-3 py-6 text-center text-xs underline">
                                      Open the PDF (signed link, five minutes)
                                    </a>
                                  ) : (
                                    <img src={asset.previewUrl} alt={asset.title} className="w-full rounded-lg border border-line" />
                                  )
                                ) : (
                                  <span className="rounded-lg border border-line bg-surface-sunken px-3 py-6 text-center text-xs text-muted">
                                    {asset.origin === 'uploaded' ? 'Stored in the bucket; preview unavailable right now.' : 'No image stored.'}
                                  </span>
                                )}
                                <span className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="truncate font-medium">{asset.title}</span>
                                    <Badge tone="neutral">v{asset.version}</Badge>
                                    <Badge tone={asset.status === 'approved' ? 'success' : 'neutral'}>{asset.status}</Badge>
                                  </span>
                                  <span className="text-xs text-muted">{asset.origin === 'uploaded' ? `uploaded ${clock.date(asset.createdAt)}` : asset.model}</span>
                                </span>
                                {asset.rightsNote ? <p className="text-xs text-muted">{asset.rightsNote}</p> : null}
                                {family.versions.length > 1 ? (
                                  <p className="text-xs text-muted">
                                    Versions: {family.versions.map((v) => `v${v.version} (${v.status})`).join(' · ')}
                                  </p>
                                ) : null}
                                {mayDecide ? (
                                  <div className="flex flex-wrap items-start gap-3">
                                    {asset.status !== 'approved' ? <ApproveAssetButton projectId={projectId} assetId={asset.id} /> : null}
                                    <UploadDesignAssetPanel projectId={projectId} storage={assetLibrary.storage} fixedKind={family.kind as 'reference'} parentAssetId={family.familyId} compact />
                                  </div>
                                ) : null}
                                <div className="flex flex-col gap-1.5 border-t border-line pt-1.5">
                                  {links.length === 0 ? (
                                    <span className="text-xs text-muted">Not linked to a screen or a UI version.</span>
                                  ) : (
                                    <ul className="flex flex-col gap-1">
                                      {links.map((l) => (
                                        <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                          {l.screenId ? (
                                            <Link href={`/projects/${projectId}/design/screens/${l.screenId}`} className="underline hover:text-foreground">
                                              {l.targetLabel}
                                            </Link>
                                          ) : (
                                            <span>{l.targetLabel}</span>
                                          )}
                                          {mayDecide ? <UnlinkAssetForm projectId={projectId} linkId={l.id} /> : null}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  {mayDecide ? <LinkAssetForm projectId={projectId} assetId={asset.id} targets={linkTargets.filter((t) => !taken.has(t.value))} /> : null}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
      {/* The reference's bottom row, in its order: Recent Activity, Design Versions, Prototype Links. */}
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <ActivityFeed
      title="Recent Activity"
      items={activityItems.slice(0, 5)}
      compact
      emptyTitle="Nothing recorded yet"
      emptyDescription="Every decision on this design writes an audit row; they appear here as they happen."
      viewAllHref={`/projects/${projectId}/activity`}
    />
        <DesignVersionsCard projectId={projectId} designVersions={designVersions} draftDesign={draftDesign} mayDecide={mayDecide} clock={clock} comments={deliverableComments} />
        <PrototypeLinksCard projectId={projectId} prototypeVersions={prototypeVersions} uiVersions={uiVersions} />
      </div>
    </div>
  );
}
