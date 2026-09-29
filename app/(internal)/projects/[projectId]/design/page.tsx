import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getProject,
  listInternalRoster,
  readDesignAssets,
  readDesignTrail,
  readProjectSpend,
  readSampleScreens,
  readUiCoverage,
} from '@/modules/projects/queries';
import {
  Badge,
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
  IconSparkle,
  IconUsers,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  ViewAll,
} from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';
import { DesignSubNav } from './design-subnav';
import { AssignReviewerForm } from './design-forms';
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
 * Master §8's decision trail (themes, colours, review queues, the client
 * loop and the final lock) stays on the tabs below; every write still goes
 * through `design-forms.tsx`.
 */
export default async function ProjectDesignPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  // The trail and the roster together — two reads, one moment (G-287).
  const [trail, roster] = await Promise.all([readDesignTrail(projectId), listInternalRoster()]);
  const [clock, clientName] = await Promise.all([agencyClock(), project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null)]);
  const { phase } = trail;
  const mayDecide = can(context.role, 'project.write');

  if (!phase) {
    return (
      <div className="flex flex-col gap-5">
        <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayDecide} />
        <ProjectSubNav projectId={projectId} />
        <DesignSubNav projectId={projectId} />
        <Nothing>
          Phase 3 has not started for this project. It opens when Phase 2 completes and the plan is active.{' '}
          <Link href={`/projects/${projectId}/plan`} className="underline hover:text-foreground">
            Open the plan
          </Link>
          .
        </Nothing>
      </div>
    );
  }

  const spend = await readProjectSpend(projectId);
  const screenCoverage = await readUiCoverage(projectId);
  const [designAssets, sampleScreens] = await Promise.all([
    readDesignAssets(projectId),
    readSampleScreens(projectId, trail.themes.map((t) => t.id)),
  ]);

  const themeById = new Map(trail.themes.map((t) => [t.id, t]));
  const reviewerName = phase.reviewerUserId ? (roster.find((r) => r.userId === phase.reviewerUserId)?.fullName ?? null) : null;
  const pendingInternal = trail.themes.filter((t) => t.internalReviewStatus === 'pending').length;
  const pendingAdmin = trail.themes.filter((t) => t.adminStatus === 'pending').length;
  const clientDecision = trail.clientDecisions[0] ?? null;
  const withPreview = sampleScreens.samples.filter((s) => s.previewAssetUrl).length;

  const steps: { label: string; state: 'done' | 'current' | 'upcoming'; caption?: string }[] = [
    { label: 'Screen list finalized', state: trail.baseline?.status === 'finalized' ? 'done' : trail.baseline ? 'current' : 'upcoming', caption: trail.baseline ? `v${trail.baseline.version} · ${trail.baseline.screenCount} screens` : undefined },
    { label: 'Theme options drafted', state: trail.themes.length > 0 ? 'done' : trail.baseline?.status === 'finalized' ? 'current' : 'upcoming', caption: trail.themes.length > 0 ? `${trail.themes.length} option${trail.themes.length === 1 ? '' : 's'}` : undefined },
    { label: 'Internal review', state: trail.themes.length > 0 && pendingInternal === 0 ? 'done' : trail.themes.length > 0 ? 'current' : 'upcoming', caption: pendingInternal > 0 ? `${pendingInternal} waiting` : undefined },
    { label: 'Admin approval', state: trail.themes.length > 0 && pendingAdmin === 0 && pendingInternal === 0 ? 'done' : pendingInternal === 0 && trail.themes.length > 0 ? 'current' : 'upcoming', caption: pendingAdmin > 0 ? `${pendingAdmin} waiting` : undefined },
    { label: 'Client decision', state: clientDecision ? 'done' : trail.shares.length > 0 ? 'current' : 'upcoming', caption: clientDecision ? humanize(clientDecision.decision) : trail.shares.length > 0 ? `Shared ${trail.shares.length}×` : undefined },
    { label: 'Locked for Phase 4', state: trail.handoff ? 'done' : clientDecision ? 'current' : 'upcoming', caption: trail.handoff ? `Locked ${when(trail.handoff.lockedAt)}` : undefined },
  ];
  const doneSteps = steps.filter((s) => s.state === 'done').length;

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayDecide} />
      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <StatGrid cols={6}>
        <Stat label="Total screens" value={String(trail.baseline?.screenCount ?? 0)} caption={trail.baseline ? `Baseline v${trail.baseline.version} · ${trail.baseline.status}` : 'No baseline drafted'} tone="brand" icon={<IconFile size={16} />} />
        <Stat label="Sample screens" value={String(sampleScreens.samples.length)} caption={`${withPreview} with a preview`} tone="info" icon={<IconPalette size={16} />} />
        <Stat label="Theme options" value={String(trail.themes.length)} caption={trail.themes.length > 0 ? `${trail.themes.filter((t) => t.clientStatus === 'selected').length} selected by the client` : undefined} tone="accent" icon={<IconSparkle size={16} />} href={`/projects/${projectId}/design/themes`} />
        <Stat label="Pending review" value={String(pendingInternal + pendingAdmin)} caption={`${pendingInternal} internal · ${pendingAdmin} admin`} tone={pendingInternal + pendingAdmin > 0 ? 'warning' : 'success'} icon={<IconClock size={16} />} />
        <Stat label="Revision rounds" value={`${phase.revisionCount}/${phase.revisionLimit}`} caption="Client rounds used, as stored" tone="neutral" icon={<IconUsers size={16} />} />
        <Stat label="Phase status" value={humanize(phase.state)} caption={phase.blockedReason ? 'Blocked' : trail.handoff ? 'Handed to Phase 4' : `Started ${when(phase.startedAt)}`} tone={phase.blockedReason ? 'danger' : trail.handoff ? 'success' : 'info'} icon={phase.blockedReason ? <IconAlert size={16} /> : <IconCheck size={16} />} />
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
            <span className="text-[13px] text-muted">· {phase.revisionCount} of {phase.revisionLimit} client revision rounds used</span>
          </div>
          {phase.blockedReason ? <p className="max-w-2xl rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">{phase.blockedReason}</p> : null}
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
              title={`Screens (${sampleScreens.samples.length}${trail.baseline ? `/${trail.baseline.screenCount}` : ''})`}
              description="The representative screens drawn for each theme option. Figma is the canonical design; a preview is a reference."
              actions={<ViewAll href={`/projects/${projectId}/design/themes`} label="Themes" />}
            />
            {sampleScreens.samples.length === 0 ? (
              <div className="px-4 pb-4 sm:px-5">
                <Nothing>No representative screen has been drawn yet. They appear as the themes tab records them.</Nothing>
              </div>
            ) : (
              <ul className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4 sm:p-5">
                {sampleScreens.samples.map((s, i) => {
                  const theme = themeById.get(s.themeOptionId);
                  return (
                    <li key={s.id} className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
                      <Link href={`/projects/${projectId}/design/themes`} className="block">
                        {s.previewAssetUrl ? (
                          // A stored preview URL from the design trail — not optimised, not ours to resize.
                          <img src={s.previewAssetUrl} alt={`${s.screenName} — ${theme?.name ?? 'theme'} preview`} className="aspect-[9/16] w-full bg-sidebar-bg object-cover" loading="lazy" />
                        ) : (
                          <span className="flex aspect-[9/16] w-full flex-col items-center justify-center gap-1 bg-sidebar-bg px-3 text-center text-sidebar-fg">
                            <IconPalette size={22} className="text-sidebar-muted" />
                            <span className="text-[13px] font-semibold">{s.screenName}</span>
                            <span className="text-[11px] text-sidebar-muted">No preview stored</span>
                          </span>
                        )}
                      </Link>
                      <div className="flex flex-col gap-1 p-2.5">
                        <span className="truncate text-[13px] font-medium text-foreground">
                          {i + 1}. {s.screenName}
                        </span>
                        <span className="truncate text-[11px] text-muted">{theme?.name ?? 'Theme'} · {humanize(s.pattern)}</span>
                        {theme ? <StatusBadge status={theme.clientStatus === 'selected' ? 'approved' : theme.internalReviewStatus} dot={false} /> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Theme options" actions={<ViewAll href={`/projects/${projectId}/design/themes`} />} />
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

          <div className="flex flex-col gap-4 [&>section]:rounded-xl [&>section]:border [&>section]:border-line [&>section]:bg-surface [&>section]:p-4 [&>section]:shadow-xs sm:[&>section]:p-5">
            {/*
              Doc 12 §9 and §20 — the coverage matrix. A REPORT, and deliberately
              not a second gate: `projects.refuse_uncovered_design` already refuses
              the three flags that are mechanically exact, and the rest are
              judgement nobody has configured. Surfacing them is the control; adding
              a threshold here would be inventing the business rule.
            */}
            <Section
              title="Screen coverage"
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

            <Section title="Cost and usage">
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
            title="Project details"
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
            <CardHeader title="Design progress" actions={<ViewAll href={`/projects/${projectId}/design/final`} label="Final selection" />} />
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
            <CardHeader
              title="Reference imagery"
              description="Optional AI-drawn inspiration (Designer §9). Never the canonical design."
              actions={
                <a href={`/api/projects/${projectId}/design/assets/export`} className="text-xs underline hover:text-foreground">
                  Handoff package (JSON)
                </a>
              }
            />
            {designAssets.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No reference image has been generated for this project.</p>
            ) : (
              /*
                SCR-038 — one folder per kind. `design_assets` carries no
                approved/draft status and no link to a screen or a version
                (there is no join table), so each folder shows the kind and
                the rights note the row was generated under, and nothing
                pretends to a state the table does not hold.
              */
              <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
                {[...new Set(designAssets.map((a) => a.kind))].map((kind) => {
                  const folder = designAssets.filter((a) => a.kind === kind);
                  return (
                    <details key={kind} open className="rounded-md border border-line">
                      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-[13px] font-medium">
                        {kind.replace(/_/g, ' ')}
                        <span className="text-xs font-normal text-muted">
                          {folder.length} image{folder.length === 1 ? '' : 's'} · reference only
                        </span>
                      </summary>
                      <ul className="flex flex-col gap-3 border-t border-line p-3">
                        {folder.map((asset) => (
                          <li key={asset.id} className="flex flex-col gap-1.5 text-[13px]">
                            <img src={`data:${asset.mediaType};base64,${asset.imageBase64}`} alt={asset.prompt} className="w-full rounded-lg border border-line" />
                            <span className="flex items-center justify-between gap-2 text-xs text-muted">
                              <Badge tone="neutral">{asset.kind.replace(/_/g, ' ')}</Badge>
                              <span>{asset.model}</span>
                            </span>
                            <p className="text-xs text-muted">{asset.rightsNote}</p>
                          </li>
                        ))}
                      </ul>
                    </details>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
