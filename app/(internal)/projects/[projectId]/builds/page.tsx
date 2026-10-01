import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listAttachedFiles } from '@/modules/projects/attached-files-queries';
import { readDeliverableDetails } from '@/modules/projects/build-details-queries';
import { listEnvironmentCheckRuns, listEnvironmentReadiness, readReleaseGates } from '@/modules/projects/environment-readiness-queries';
import { READINESS_CHECK_LABEL, READINESS_CHECKS } from '@/modules/projects/environment-readiness-schema';
import { listGitActions } from '@/modules/projects/git-queries';
import { getProject, listDependencies, listDeliverables, listEnvironments, readPlanBoard } from '@/modules/projects/queries';
import { getRepositoryLink } from '@/modules/projects/repository-link-queries';
import { Badge, buttonClass, Card, CardHeader, EmptyState, humanize, IconIntegrations, IconProjects, inputClass, labelClass, PageHeader, selectClass, Stat, StatGrid, statusTone, PermissionDenied } from '@/ui';

import { AttachFileForm } from '../attach-file-form';
import { AttachedFileLinks } from '../attached-file-links';
import { AddBuildForm, SubmitDeliverableForm } from '../deliverables-panel';
import {
  AddDependencyForm,
  AddEnvironmentForm,
  DependencyCard,
  EnvironmentCard,
} from '../environments-panel';
import { PreviewButton, PreviewDrawerProvider } from '../../../preview-drawer';
import { ProjectSubNav } from '../project-subnav';
import { BuildDetailsForm } from '../prototype/build-panels';
import { describeCheckRun } from '@/modules/projects/environment-check-runs';
import { PromoteBuildPanel, ReadCheckResultButton, RecordCheckPanel, RunChecksPanel, TriggerBuildPanel } from './environment-readiness-panels';

export const metadata: Metadata = { title: 'Builds' };

/**
 * SCR-043 — Builds, Environments and Dependencies. Builds reuse the same
 * `deliverables` reader Prototype (SCR-037) does, filtered to `kind = 'build'`
 * — no new backend, same relationship Board has to Development. Environments
 * and Dependencies, added 2026-09-22, follow the exact "link, never a blob"
 * precedent `project_files`/`repositories` already set (see the migration,
 * 20260922140000_where_it_runs_and_what_it_runs_on.sql).
 *
 * Bucket F (migration 20261001130000): every environment carries three
 * readiness checks — API contracts, DB migrations, external service
 * configuration — each recorded by a person with an evidence link; the
 * environment matrix shows them side by side with the release gates
 * (`qa.release_gates`) as they stand now; a build is promoted to an
 * environment only when every check is recorded and ok and no gate is red
 * (the database refuses otherwise, naming what is missing); "Trigger build"
 * records a `git_actions` row and dispatches the linked GitHub Actions
 * workflow when the Repository tab names one.
 */
export default async function BuildsPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ q?: string; status?: string; dep?: string }> }) {
  const { projectId } = await params;
  const { q: qRaw, status: statusRaw, dep: depRaw } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/builds`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const canWrite = can(context, 'project.write');
  const [deliverables, environments, dependencies, board, readiness, gates, link, gitActions, details, checkRuns, attachedFiles] = await Promise.all([
    listDeliverables(projectId),
    listEnvironments(projectId),
    listDependencies(projectId),
    readPlanBoard(projectId),
    listEnvironmentReadiness(projectId),
    readReleaseGates(projectId),
    getRepositoryLink(projectId),
    listGitActions(projectId, 10),
    readDeliverableDetails(projectId),
    listEnvironmentCheckRuns(projectId),
    // Q-C1: the build files uploaded against each build.
    listAttachedFiles(projectId),
  ]);
  const allBuilds = deliverables.filter((d) => d.kind === 'build');
  const q = (qRaw ?? '').trim().slice(0, 120).toLowerCase();
  const statusFilter = ['draft', 'in_review', 'approved', 'changes_requested', 'superseded'].includes(statusRaw ?? '') ? (statusRaw as string) : '';
  const depFilter = ['open', 'supplied', 'waived'].includes(depRaw ?? '') ? (depRaw as string) : '';
  const builds = allBuilds.filter((b) => (!q || `${b.title} v${b.version} ${details.get(b.id)?.commitRef ?? ''} ${details.get(b.id)?.buildNumber ?? ''}`.toLowerCase().includes(q)) && (!statusFilter || b.status === statusFilter));
  const shownDependencies = dependencies.filter((d) => (!q || `${d.name} ${d.reference ?? ''} ${d.notes ?? ''}`.toLowerCase().includes(q)) && (!depFilter || d.status === depFilter));
  const compatible = readiness.filter((e) => e.checks.api_contract?.ok === true && e.checks.migrations?.ok === true).length;
  const liveBuilds = allBuilds.filter((b) => b.status !== 'superseded').map((b) => ({ id: b.id, version: b.version, title: b.title, status: b.status }));
  const latestBuild = allBuilds[0] ?? null;
  const blockingDependencies = board.dependencies.filter((d) => ['pending', 'requested', 'blocked'].includes(d.status));
  const openTechnical = dependencies.filter((d) => d.status === 'open');
  const readyEnvironments = readiness.filter((e) => e.ready).length;
  const redGates = gates.filter((g) => g.state === 'fail');
  const undecidedGates = gates.filter((g) => g.state === 'undecided');
  const buildTriggers = gitActions.filter((a) => a.action === 'build_triggered');
  const buildById = new Map(allBuilds.map((b) => [b.id, b]));

  return (
    <PreviewDrawerProvider>
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Builds`}
        description={allBuilds.length === 0 ? 'No builds yet.' : `${allBuilds.length} version${allBuilds.length === 1 ? '' : 's'}.`}
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={4}>
        <Stat
          label="Latest build"
          value={latestBuild ? `v${latestBuild.version}` : '—'}
          caption={latestBuild ? `${humanize(latestBuild.status)} · ${clock.date(latestBuild.created_at)}` : 'no build recorded'}
          tone={latestBuild ? statusTone(latestBuild.status) : 'neutral'}
          href="#builds"
        />
        <Stat
          label="Environments ready"
          value={environments.length === 0 ? '—' : `${readyEnvironments}/${environments.length}`}
          caption={environments.length === 0 ? 'none linked yet' : 'all three checks recorded and ok'}
          tone={environments.length > 0 && readyEnvironments === environments.length ? 'success' : environments.length > 0 ? 'warning' : 'neutral'}
          href="#environments"
        />
        <Stat
          label="Migration and API Compatibility"
          value={environments.length === 0 ? '—' : `${compatible}/${environments.length}`}
          caption={environments.length === 0 ? 'no environment linked yet' : 'environments with API contracts and migrations both checked ok'}
          tone={environments.length > 0 && compatible === environments.length ? 'success' : environments.length > 0 ? 'warning' : 'neutral'}
          href="#environments"
        />
        <Stat
          label="Release gates"
          value={gates.length === 0 ? '—' : `${gates.length - redGates.length - undecidedGates.length}/${gates.length}`}
          caption={redGates.length > 0 ? `${redGates.length} red` : undecidedGates.length > 0 ? `${undecidedGates.length} undecided` : 'all green'}
          tone={redGates.length > 0 ? 'danger' : undecidedGates.length > 0 ? 'warning' : 'success'}
          href={`/projects/${projectId}/release`}
        />
        <Stat
          label="Dependency blockers"
          value={String(blockingDependencies.length)}
          caption={board.plan ? `on plan v${board.plan.version} · ${board.dependencies.length - blockingDependencies.length} settled` : 'no plan yet'}
          tone={blockingDependencies.some((d) => d.status === 'blocked') ? 'danger' : blockingDependencies.length > 0 ? 'warning' : 'success'}
          href={`/projects/${projectId}/plan`}
        />
        <Stat
          label="Technical dependencies"
          value={String(dependencies.length)}
          caption={dependencies.length === 0 ? 'recorded below' : `${openTechnical.length} open · ${dependencies.length - openTechnical.length} supplied or waived`}
          tone={openTechnical.length > 0 ? 'warning' : dependencies.length > 0 ? 'success' : 'neutral'}
          href="#dependencies"
        />
        <Stat
          label="Build triggers"
          value={String(buildTriggers.length)}
          caption={link?.workflowFile ? `dispatches ${link.workflowFile}` : link ? 'record only — no workflow file' : 'no repository linked'}
          tone={buildTriggers.length > 0 ? 'info' : 'neutral'}
          href={`/projects/${projectId}/repository`}
        />
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
            These are the plan&apos;s register. Marking one received is a change to the plan, which the database accepts only on a draft plan — open the next plan version on the Plan tab. The technical dependencies below are the other register, and can be marked supplied here.
          </p>
        </Card>
      ) : null}

      {/* SCR-043 — the environment matrix: environments × the three checks, the promoted build, the gates. */}
      <Card id="environments" className="scroll-mt-4">
        <CardHeader
          title="Environment readiness"
          description="Per environment: API contracts, DB migrations and external service configuration, each recorded by a person with evidence, or by a GitHub workflow dispatched from here (the run's link is the evidence). Migration/API compatibility is these checks; promotion refuses until all three are ok and no release gate is red."
        />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {readiness.length === 0 ? (
            <p className="text-[13px] text-muted">No environment linked yet — link one below and its checks appear here.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="py-1 pr-3 font-normal">Environment</th>
                    {READINESS_CHECKS.map((c) => (
                      <th key={c} className="py-1 pr-3 font-normal">
                        {READINESS_CHECK_LABEL[c]}
                      </th>
                    ))}
                    <th className="py-1 pr-3 font-normal">Promoted build</th>
                  </tr>
                </thead>
                <tbody>
                  {readiness.map((e) => (
                    <tr key={e.id} className="border-b border-line align-top">
                      <td className="py-2 pr-3">
                        <span className="flex flex-col">
                          <span className="font-medium">{e.label}</span>
                          <span className="text-xs text-muted">{humanize(e.kind)}</span>
                          <Badge tone={e.ready ? 'success' : 'warning'} dot={false} className="mt-1 w-fit">
                            {e.ready ? 'ready' : 'not ready'}
                          </Badge>
                          {/* Owner decision 13: the contract and migration checks run as a GitHub workflow dispatched from here. */}
                          {(checkRuns.get(e.id) ?? []).map((r) => (
                            <span key={r.id} className="mt-1 flex flex-col text-xs text-muted">
                              <span>
                                {describeCheckRun(r)}
                                {r.runUrl ? (
                                  <>
                                    {' '}
                                    <a href={r.runUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                                      run
                                    </a>
                                  </>
                                ) : null}
                              </span>
                              <span>{clock.dateTime(r.dispatchedAt)}</span>
                            </span>
                          ))}
                          {canWrite ? (
                            <span className="mt-2 flex flex-col gap-2">
                              <RunChecksPanel projectId={projectId} environmentId={e.id} linked={Boolean(link)} />
                              {link && (checkRuns.get(e.id) ?? []).some((r) => !r.recorded) ? <ReadCheckResultButton projectId={projectId} environmentId={e.id} /> : null}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      {READINESS_CHECKS.map((c) => {
                        const entry = e.checks[c];
                        return (
                          <td key={c} className="py-2 pr-3">
                            <span className="flex flex-col gap-1">
                              {entry ? (
                                <span className="flex flex-wrap items-center gap-1">
                                  <Badge tone={entry.ok ? 'success' : 'danger'}>{entry.ok ? 'pass' : 'fail'}</Badge>
                                  {entry.evidenceUrl ? (
                                    <a href={entry.evidenceUrl} target="_blank" rel="noreferrer noopener" className="text-xs underline underline-offset-2">
                                      evidence
                                    </a>
                                  ) : (
                                    <span className="text-xs text-muted">no evidence link</span>
                                  )}
                                  {entry.checkedAt ? <span className="text-xs text-muted">{clock.dateTime(entry.checkedAt)}</span> : null}
                                  {entry.source === 'workflow' ? <span className="text-xs text-muted">by GitHub workflow</span> : null}
                                </span>
                              ) : (
                                <Badge tone="neutral">not checked</Badge>
                              )}
                              {entry?.note ? <span className="text-xs text-muted">{entry.note}</span> : null}
                              {canWrite ? <RecordCheckPanel projectId={projectId} environmentId={e.id} check={c} /> : null}
                            </span>
                          </td>
                        );
                      })}
                      <td className="py-2 pr-3">
                        <span className="flex flex-col gap-1">
                          {e.promotedBuildId ? (
                            <span>
                              v{buildById.get(e.promotedBuildId)?.version ?? '?'} — {buildById.get(e.promotedBuildId)?.title ?? 'build'}
                              {e.promotedAt ? <span className="block text-xs text-muted">promoted {clock.dateTime(e.promotedAt)}</span> : null}
                            </span>
                          ) : (
                            <span className="text-muted">none promoted</span>
                          )}
                          {canWrite ? <PromoteBuildPanel projectId={projectId} environmentId={e.id} builds={liveBuilds} promotedBuildId={e.promotedBuildId} /> : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-sunken p-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">Release gates, as they stand</span>
            {gates.length === 0 ? (
              <span className="text-[13px] text-muted">No gate answers yet.</span>
            ) : (
              <ul className="flex flex-wrap gap-2 text-[13px]">
                {gates.map((g) => (
                  <li key={g.gate} className="flex items-center gap-1">
                    <Badge tone={g.state === 'pass' ? 'success' : g.state === 'fail' ? 'danger' : 'warning'}>{g.state}</Badge>
                    <span>{humanize(g.gate)}</span>
                    {g.detail ? <span className="text-xs text-muted">— {g.detail}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <Link href={`/projects/${projectId}/release`} className="text-xs underline hover:text-foreground">
              Release tab
            </Link>
          </div>
        </div>
      </Card>

      {/* SCR-043 — trigger build: a record, plus a workflow dispatch when one is linked. */}
      <Card>
        <CardHeader
          title={`Trigger build (${buildTriggers.length} so far)`}
          description={link ? `Repository ${link.owner}/${link.repo}${link.workflowFile ? ` — dispatches ${link.workflowFile} on ${link.defaultBranch}` : ' — no workflow file linked, so a trigger is recorded only'}.` : 'Link a GitHub repository on the Repository tab to trigger a build from here.'}
        />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {canWrite ? <TriggerBuildPanel projectId={projectId} workflowFile={link?.workflowFile ?? null} linked={Boolean(link)} /> : null}
          {buildTriggers.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {buildTriggers.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <Badge tone={a.detail.dispatched === true ? 'info' : 'neutral'}>{a.detail.dispatched === true ? 'dispatched' : 'recorded'}</Badge>
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline-offset-2 hover:underline">
                      {a.reference}
                    </a>
                  ) : (
                    <span className="font-mono text-xs">{a.reference}</span>
                  )}
                  {typeof a.detail.note === 'string' && a.detail.note ? <span className="text-muted">{a.detail.note}</span> : null}
                  <span className="text-xs text-muted">{clock.dateTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>

      <div id="builds" className="scroll-mt-4" />
      {allBuilds.length > 0 || dependencies.length > 0 ? (
        <form method="get" action={`/projects/${projectId}/builds#builds`} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Search builds and dependencies</span>
            <input name="q" defaultValue={qRaw ?? ''} maxLength={120} placeholder="Title, version, commit or build number" className={`${inputClass} w-64`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Build status</span>
            <select name="status" defaultValue={statusFilter} className={selectClass}>
              <option value="">Any status</option>
              {['draft', 'in_review', 'approved', 'changes_requested', 'superseded'].map((st) => (
                <option key={st} value={st}>{humanize(st)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Dependency status</span>
            <select name="dep" defaultValue={depFilter} className={selectClass}>
              <option value="">Any status</option>
              {['open', 'supplied', 'waived'].map((st) => (
                <option key={st} value={st}>{humanize(st)}</option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClass('secondary', 'sm')}>Apply</button>
          {q || statusFilter || depFilter ? <Link href={`/projects/${projectId}/builds`} className="pb-2 text-xs underline hover:text-foreground">Clear</Link> : null}
        </form>
      ) : null}
      {builds.length > 0 ? (
        <div className="flex flex-col gap-2">
          {builds.map((b) => (
            <Card key={b.id} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  v{b.version} — {b.title}
                </span>
                <span className="flex items-center gap-2">
                  <PreviewButton group="Build" id={b.id} />
                  {readiness.some((e) => e.promotedBuildId === b.id) ? (
                    <Badge tone="success">promoted to {readiness.filter((e) => e.promotedBuildId === b.id).map((e) => e.label).join(', ')}</Badge>
                  ) : null}
                  <Badge tone={statusTone(b.status)}>{humanize(b.status)}</Badge>
                </span>
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
              <AttachedFileLinks projectId={projectId} files={attachedFiles.get(b.id)} label={`Build files of v${b.version}`} />
              {(() => {
                // SCR-043 — build reproducibility and rollback information, retained per build.
                const d = details.get(b.id);
                const target = d?.rollbackTargetId ? buildById.get(d.rollbackTargetId) : null;
                return (
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-muted">Built from</dt>
                      <dd>{d?.commitRef ? <span className="font-mono text-xs">{d.commitRef}</span> : <span className="text-warning">no commit or ref recorded</span>}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Build number</dt>
                      <dd>{d?.buildNumber ?? <span className="text-muted">—</span>}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Roll back to</dt>
                      <dd>{target ? `v${target.version} — ${target.title}` : <span className="text-warning">no rollback target recorded</span>}{d?.rollbackNote ? <span className="block text-xs text-muted">{d.rollbackNote}</span> : null}</dd>
                    </div>
                  </dl>
                );
              })()}
              {canWrite ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs underline underline-offset-2">Edit commit, number and rollback</summary>
                  <div className="pt-2">
                    <BuildDetailsForm
                      projectId={projectId}
                      deliverableId={b.id}
                      showPlatform={false}
                      current={{ platform: null, commitRef: details.get(b.id)?.commitRef ?? null, buildNumber: details.get(b.id)?.buildNumber ?? null, rollbackTargetId: details.get(b.id)?.rollbackTargetId ?? null, rollbackNote: details.get(b.id)?.rollbackNote ?? null }}
                      rollbackChoices={allBuilds.filter((x) => x.id !== b.id).map((x) => ({ id: x.id, label: `Build v${x.version} — ${x.title}` }))}
                    />
                  </div>
                </details>
              ) : null}
              {canWrite ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs underline underline-offset-2">Attach a build file (.apk, .ipa, .zip)</summary>
                  <div className="pt-2">
                    <AttachFileForm projectId={projectId} subjectKind="build" subjectId={b.id} />
                  </div>
                </details>
              ) : null}
              {canWrite && b.status === 'draft' ? (
                <SubmitDeliverableForm deliverableId={b.id} projectId={projectId} />
              ) : null}
            </Card>
          ))}
        </div>
      ) : allBuilds.length > 0 ? (
        <EmptyState icon={<IconProjects size={22} />} title="No build matches" description="Nothing in the list fits that search or filter." action={<Link href={`/projects/${projectId}/builds`} className={buttonClass('secondary', 'sm')}>Clear filters</Link>} />
      ) : (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="No builds yet"
          description="Add the first build below once it's ready to review."
          action={<a href="#add-build" className={buttonClass('secondary', 'sm')}>Add a build</a>}
        />
      )}

      {canWrite ? (
        <Card id="add-build" className="scroll-mt-4 p-4">
          <AddBuildForm projectId={projectId} rollbackChoices={allBuilds.map((x) => ({ id: x.id, label: `Build v${x.version} — ${x.title}` }))} />
        </Card>
      ) : null}

      <PageHeader
        as="h2"
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

      <div id="dependencies" className="scroll-mt-4" />
      <PageHeader
        as="h2"
        title="Dependencies"
        description={
          dependencies.length === 0
            ? 'No dependencies recorded yet.'
            : `${dependencies.length} dependenc${dependencies.length === 1 ? 'y' : 'ies'}.`
        }
      />
      {dependencies.length > 0 && shownDependencies.length === 0 ? (
        <EmptyState icon={<IconIntegrations size={22} />} title="No dependency matches" description="Nothing in the list fits that search or filter." action={<Link href={`/projects/${projectId}/builds`} className={buttonClass('secondary', 'sm')}>Clear filters</Link>} />
      ) : null}
      {shownDependencies.length > 0 ? (
        <div className="flex flex-col gap-2">
          {shownDependencies.map((d) => (
            <DependencyCard key={d.id} dependency={{ ...d, suppliedAtLabel: d.suppliedAt ? clock.date(d.suppliedAt) : undefined }} projectId={projectId} editable={canWrite} />
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
    </PreviewDrawerProvider>
  );
}
