import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { agencyClock } from '@/lib/admin/agency-clock';
import { listAttachedFiles } from '@/modules/projects/attached-files-queries';
import { getProject, listDeliverables, listInternalRoster, readScopeBaseline, listDevelopmentBreakdown } from '@/modules/projects/queries';
import { listTestPlanVersions, listTestRunDetails, readDefectHistory } from '@/modules/qa/dashboard-queries';
import { listTestCaseResults } from '@/modules/qa/case-results-queries';
import { listDefects, listTestRuns, readTestPlan } from '@/modules/qa/queries';
import { readBaselineComparison } from '@/modules/qa/baseline-queries';
import { describeCron } from '@/modules/qa/cron';
import { compareToBudgets, listMetricResults, listPerformanceBudgets, listStabilityIncidents } from '@/modules/qa/performance-queries';
import { listSuiteSchedules } from '@/modules/qa/schedule-queries';
import { readClientName } from '@/lib/admin/clients';
import { mergeDeviceCards } from '@/modules/qa/device-config';
import { listDeviceConfigurations } from '@/modules/qa/device-queries';
import { readRequirementCoverage } from '@/modules/qa/coverage-queries';
import { deviceTiles, PLATFORMS, type Platform } from '@/modules/qa/device-tiles';
import { DeviceTestingCard, QaTeamCard } from '@/modules/qa/qa-device-view';
import { listDeviceRuns, readQaTeam } from '@/modules/qa/qa-team-queries';
import { Badge, Card, CardHeader, IconAlert, IconCheck as IconOk, IconClock, IconList, Stat, StatGrid } from '@/ui';

import { BudgetForm, CloseRunForm, MetricForm, OpenIncidentForm, OpenRunForm, RerunButton, ResolveIncidentForm, ScheduleSuiteForm } from './run-lifecycle-panel';
import { EmptyState, IconCheck, PermissionDenied } from '@/ui';

import { PreviewButton, PreviewDrawerProvider } from '../../../preview-drawer';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';
import { AttachFileForm } from '../attach-file-form';
import { AttachedFileLinks } from '../attached-file-links';
import { RaiseDefectForm } from '../qa-panel';
import { DraftTestPlanForm, TestPlanCard, TestRunsCard } from '../test-plan-panel';
import { QaInsights } from './qa-insights';
import { AddDeviceForm, DeviceSupportForm } from '../../../qa/device-forms';

export const metadata: Metadata = { title: 'Test plan' };

/**
 * SCR-045 — what this project is to be tested for. Needs a frozen scope
 * baseline to point at (Doc 14 §3); if none is active yet, this page sends
 * the reader to the Scope tab rather than rendering a dead end.
 */
export default async function TestPlanPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ compare?: string; baseline?: string; defects?: string; severity?: string; platform?: string; runs?: string; suite?: string }> }) {
  const { projectId } = await params;
  // SCR-047: ?defects=open|fixed|reopened and ?severity= filter the bug list — the KPI tiles' own links.
  const { compare, baseline, defects: defectsFilter, severity: severityFilter, platform: platformRaw, runs: runsFilter, suite: suiteFilter } = await searchParams;
  const platform = (PLATFORMS as readonly string[]).includes(platformRaw ?? '') ? (platformRaw as Platform) : null;

  const context = await requireInternal(`/projects/${projectId}/qa`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clientName = project.client_account_id ? await readClientName(project.client_account_id) : null;
  const [{ active }, plan, deliverables, runs, runDetails, planVersions, defects, roster, clock, caseResults, { tasks }] = await Promise.all([
    readScopeBaseline(projectId),
    readTestPlan(projectId),
    listDeliverables(projectId),
    listTestRuns(projectId),
    listTestRunDetails(projectId),
    listTestPlanVersions(projectId),
    listDefects(projectId),
    listInternalRoster(),
    agencyClock(),
    listTestCaseResults(projectId),
    // SCR-047 — the tasks a defect can be linked to.
    listDevelopmentBreakdown(projectId, { excludeCancelled: true }),
  ]);
  // SCR-047 — the fix / retest trail, one read for every defect on the project.
  const history = await readDefectHistory(defects.map((d) => d.id));
  // Q-C6: the evidence files uploaded against each run and bug.
  const attachedFiles = await listAttachedFiles(projectId);
  const canWrite = can(context, 'project.write');
  const canRecordRuns = can(context, 'task.write');
  // SCR-045 — approving the plan is the QA sign-off's own role (owner, ops admin).
  const canApprove = can(context, 'project.sign_off');
  const builds = deliverables.filter((d) => d.kind === 'build').map((d) => ({ id: d.id, title: d.title, version: d.version }));
  // SCR-046/048 (bucket F): the run lifecycle, metrics against budgets,
  // incidents, schedules, and a baseline comparison when ?compare= names a run.
  const [budgets, metrics, incidents, schedules, comparison] = await Promise.all([
    listPerformanceBudgets(projectId),
    listMetricResults(runs.map((r) => r.id)),
    listStabilityIncidents(projectId),
    listSuiteSchedules(projectId),
    compare && /^[0-9a-f-]{36}$/i.test(compare) ? readBaselineComparison(projectId, compare, baseline && /^[0-9a-f-]{36}$/i.test(baseline) ? baseline : undefined) : Promise.resolve(null),
  ]);
  const budgetLines = compareToBudgets(budgets, metrics);
  const [deviceRuns, qaTeam, deviceConfigs, coverage] = await Promise.all([
    listDeviceRuns(projectId),
    readQaTeam(projectId),
    listDeviceConfigurations(),
    // SCR-045: every requirement of the baseline, with its cases or the reason it has none.
    plan && active ? readRequirementCoverage(plan.id, plan.scopeVersionId) : Promise.resolve(undefined),
  ]);
  const tiles = mergeDeviceCards(deviceTiles(deviceRuns), deviceConfigs);
  const testers = roster.map((m) => ({ userId: m.userId, fullName: m.fullName }));
  // SCR-046: the run list is filterable by status and suite (links, so a filter is a URL).
  const shownRuns = runs.filter((r) => (!runsFilter || (runsFilter === 'open' ? r.status === 'open' : runsFilter === 'failed' ? r.failed > 0 || r.blocked > 0 : runsFilter === 'closed' ? r.status === 'closed' : true)) && (!suiteFilter || r.suite === suiteFilter));
  const runFilterHref = (over: { runs?: string | null; suite?: string | null }) => {
    const next = new URLSearchParams();
    const r = over.runs === undefined ? runsFilter : over.runs;
    const su = over.suite === undefined ? suiteFilter : over.suite;
    if (r) next.set('runs', r);
    if (su) next.set('suite', su);
    const q = next.toString();
    return `/projects/${projectId}/qa${q ? `?${q}` : ''}#run-lifecycle`;
  };

  return (
    <PreviewDrawerProvider>
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={canWrite} />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={4}>
        <Stat label="Test runs" value={String(runs.length)} caption={`${runs.filter((r) => r.status === 'open').length} open`} tone="brand" icon={<IconList size={16} />} />
        <Stat label="Passed" value={String(runs.reduce((n, r) => n + r.passed, 0))} caption={runs.reduce((n, r) => n + r.passed + r.failed + r.blocked, 0) > 0 ? `${Math.round((runs.reduce((n, r) => n + r.passed, 0) / runs.reduce((n, r) => n + r.passed + r.failed + r.blocked, 0)) * 100)}% of recorded results` : 'No results recorded'} tone="success" icon={<IconOk size={16} />} />
        <Stat label="Failed" value={String(runs.reduce((n, r) => n + r.failed, 0))} caption={`${runs.reduce((n, r) => n + r.blocked, 0)} blocked`} tone={runs.some((r) => r.failed > 0) ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} />
        <Stat label="Open defects" value={String(defects.filter((d) => d.status !== 'verified' && d.status !== 'wontfix').length)} caption="Not yet verified" tone="warning" icon={<IconClock size={16} />} />
      </StatGrid>

      {!active ? (
        <EmptyState
          icon={<IconCheck size={22} />}
          title="No frozen scope baseline yet"
          description={
            <>
              A test plan needs a frozen baseline to point at.{' '}
              <Link href={`/projects/${projectId}/scope`} className="underline underline-offset-2">
                Open the Scope tab
              </Link>{' '}
              to draft and freeze one first.
            </>
          }
        />
      ) : plan ? (
        <TestPlanCard projectId={projectId} plan={plan} scopeItems={active.items} editable={canWrite} canApprove={canApprove} tasks={tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }))} coverage={coverage} />
      ) : (
        <>
          <EmptyState icon={<IconCheck size={22} />} title="No test plan yet" description={`Baseline v${active.version} is frozen and ready to plan against.`} />
          {canWrite ? <DraftTestPlanForm projectId={projectId} scopeVersionId={active.id} /> : null}
        </>
      )}

      <TestRunsCard projectId={projectId} runs={runs} builds={builds} editable={canRecordRuns} planItems={plan?.items ?? []} results={caseResults} testers={testers} />

      {/* SCR-044: device tiles (from the runs' own device / evidence) and the QA roster (project role qa). */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(19rem,1fr)]">
        <DeviceTestingCard
          tiles={tiles}
          active={platform}
          hrefFor={(p) => (p ? `/projects/${projectId}/qa?platform=${p}#device-testing` : `/projects/${projectId}/qa#device-testing`)}
          addHref={`/projects/${projectId}/qa#run-lifecycle`}
          date={(iso) => clock.date(iso)}
          addForm={canWrite ? <AddDeviceForm /> : undefined}
          renderSupport={canWrite ? (t) => (t.configId ? <DeviceSupportForm deviceId={t.configId} status={t.state === 'unsupported' ? 'unsupported' : 'supported'} name={t.name} /> : null) : undefined}
        />
        <QaTeamCard team={qaTeam} manageHref={`/projects/${projectId}/team`} />
      </div>

      {/* SCR-046 (bucket F): a run has a life — open it, close it once with its counts (blocked is its own column), rerun what failed. */}
      <Card id="run-lifecycle">
        <CardHeader title="Run lifecycle" description="Open a run against a build; close it once with passed, failed, skipped and blocked; rerun a closed run's failed cases as a new run that points back at it. A closed run is evidence and never changes." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {canRecordRuns ? <OpenRunForm projectId={projectId} builds={builds} testers={testers} /> : null}
          {runs.length > 0 ? (
            <nav aria-label="Filter runs" className="flex flex-wrap items-center gap-2 text-[13px]">
              {[
                { label: 'All', key: null },
                { label: 'Open', key: 'open' },
                { label: 'Closed', key: 'closed' },
                { label: 'Failed or blocked', key: 'failed' },
              ].map((f) => (
                <Link key={f.label} href={runFilterHref({ runs: f.key })} aria-current={(runsFilter ?? null) === f.key ? 'true' : undefined} className={`rounded-lg border px-3 py-1 ${(runsFilter ?? null) === f.key ? 'border-brand/40 bg-brand-soft text-brand' : 'border-line bg-surface text-muted hover:bg-surface-hover'}`}>
                  {f.label}
                </Link>
              ))}
              <span aria-hidden className="text-faint">·</span>
              {[null, ...[...new Set(runs.map((r) => r.suite))].sort()].map((su) => (
                <Link key={su ?? 'all-suites'} href={runFilterHref({ suite: su })} aria-current={(suiteFilter ?? null) === su ? 'true' : undefined} className={`rounded-lg border px-3 py-1 ${(suiteFilter ?? null) === su ? 'border-brand/40 bg-brand-soft text-brand' : 'border-line bg-surface text-muted hover:bg-surface-hover'}`}>
                  {su ?? 'Every suite'}
                </Link>
              ))}
            </nav>
          ) : null}
          {runs.length === 0 ? (
            <p className="text-[13px] text-muted">No run yet. Open one above, against a build, to start recording evidence.</p>
          ) : shownRuns.length === 0 ? (
            <p className="text-[13px] text-muted">No run matches that filter. <Link href={`/projects/${projectId}/qa#run-lifecycle`} className="text-brand hover:underline">Show every run</Link></p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shownRuns.slice(0, 30).map((run) => (
                <li key={run.id} id={`run-${run.id}`} className="flex flex-col gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={run.status === 'open' ? 'warning' : run.failed > 0 || run.blocked > 0 ? 'danger' : 'success'}>{run.status}</Badge>
                      <span className="font-medium">{run.suite}</span>
                      <span className="text-muted">v{builds.find((b) => b.id === run.deliverableId)?.version ?? '?'}</span>
                      {run.environment ? <Badge tone="neutral">{run.environment}</Badge> : null}
                      {run.testerId ? <span className="text-xs text-muted">tester {testers.find((t) => t.userId === run.testerId)?.fullName ?? 'on the team'}</span> : null}
                      {run.rerunOf ? <Link href={`/projects/${projectId}/qa/runs/${run.rerunOf}`} className="text-xs text-brand hover:underline">rerun of an earlier run</Link> : null}
                    </span>
                    <span className="text-xs text-muted">
                      {run.startedAt ? `started ${clock.dateTime(run.startedAt)}` : `recorded ${clock.dateTime(run.executedAt)}`}
                      {run.endedAt ? ` · ended ${clock.dateTime(run.endedAt)}` : ''}
                      {run.status === 'closed' ? ` · ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped, ${run.blocked} blocked` : ''}
                    </span>
                  </div>
                  {(metrics.get(run.id) ?? []).length > 0 ? (
                    <p className="text-xs text-muted">Metrics: {(metrics.get(run.id) ?? []).map((m) => `${m.metric} ${m.value} ${m.unit}`).join(' · ')}</p>
                  ) : null}
                  <AttachedFileLinks projectId={projectId} files={attachedFiles.get(run.id)} label="Evidence files of this run" />
                  {canRecordRuns && run.status === 'open' ? <CloseRunForm projectId={projectId} runId={run.id} /> : null}
                  <div className="flex flex-wrap items-center gap-3">
                    {canRecordRuns && run.status === 'closed' && (run.failed > 0 || run.blocked > 0) ? <RerunButton projectId={projectId} runId={run.id} /> : null}
                    {canRecordRuns ? <MetricForm projectId={projectId} runId={run.id} /> : null}
                    {run.status === 'closed' ? <Link href={`/projects/${projectId}/qa?compare=${run.id}#baseline`} className="text-xs text-brand hover:underline">Compare against baseline</Link> : null}
                    <PreviewButton group="Test Run" id={run.id} />
                    <Link href={`/projects/${projectId}/qa/runs/${run.id}`} className="text-xs font-medium text-brand hover:underline">Open run</Link>
                    <span className="text-xs text-muted">{defects.filter((d) => d.run_id === run.id).length} defect{defects.filter((d) => d.run_id === run.id).length === 1 ? '' : 's'} from this run</span>
                  </div>
                  {canRecordRuns ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-brand">Attach an evidence file (screenshot, log)</summary>
                      <div className="mt-2">
                        <AttachFileForm projectId={projectId} subjectKind="test_run" subjectId={run.id} />
                      </div>
                    </details>
                  ) : null}
                  {canWrite ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-brand">Raise a defect from this run</summary>
                      <div className="mt-2">
                        <RaiseDefectForm projectId={projectId} deliverables={deliverables.map((d) => ({ id: d.id, kind: d.kind, version: d.version, title: d.title }))} defaultDeliverableId={run.deliverableId} defaultRunId={run.id} />
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* SCR-048 (bucket F): baseline comparison — two runs of the same suite, what changed. */}
      {compare ? (
        <Card>
          <div id="baseline">
            <CardHeader
              title="Compare against baseline"
              description={comparison ? `Candidate ${clock.dateTime(comparison.candidate.executedAt)} against baseline ${clock.dateTime(comparison.baseline.executedAt)} (the newest closed ${comparison.baseline.suite} run before it, unless ?baseline= names one).` : 'No earlier closed run of that suite to compare against.'}
            />
          </div>
          {comparison ? (
            <div className="flex flex-col gap-3 px-4 pb-4 text-[13px] sm:px-5">
              <p>
                Pass rate {comparison.passRate.baseline ?? '—'}% → {comparison.passRate.candidate ?? '—'}%
                {comparison.passRate.delta !== null ? <span className={comparison.passRate.delta < 0 ? ' text-danger' : ' text-success'}> ({comparison.passRate.delta > 0 ? '+' : ''}{comparison.passRate.delta})</span> : null}
                {' · '}<span className={comparison.regressed > 0 ? 'text-danger' : ''}>{comparison.regressed} regressed</span> · <span className="text-success">{comparison.recovered} recovered</span>
              </p>
              {comparison.cases.filter((c) => c.change !== 'unchanged').length > 0 ? (
                <ul className="flex flex-col gap-1 text-xs">
                  {comparison.cases.filter((c) => c.change !== 'unchanged').map((c) => (
                    <li key={c.planItemId} className="flex items-center gap-2">
                      <Badge tone={c.change === 'regressed' ? 'danger' : c.change === 'recovered' ? 'success' : 'neutral'}>{c.change}</Badge>
                      <span className="text-muted">{plan?.items.find((i) => i.id === c.planItemId)?.scopeItemTitle ?? c.planItemId}</span>
                      <span className="text-muted">{c.baseline ?? '—'} → {c.candidate ?? '—'}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">No per-case result changed between the two runs.</p>
              )}
              {comparison.metrics.length > 0 ? (
                <ul className="flex flex-col gap-1 text-xs">
                  {comparison.metrics.map((m) => (
                    <li key={m.metric} className="tabular">
                      <span className="font-medium">{m.metric}</span> {m.baseline ?? '—'} → {m.candidate ?? '—'} {m.unit}
                      {m.deltaPercent !== null ? <span className="text-muted"> ({m.deltaPercent > 0 ? '+' : ''}{m.deltaPercent}%)</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* SCR-048 (bucket F): performance budgets against the latest results, stability incidents, and suite schedules. */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Performance budgets" description="A target per metric (at most for a latency, at least for a score). The latest attached metric decides the standing — a report, not a gate (Doc 14 §16)." />
          <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
            {budgetLines.length === 0 ? <p className="text-[13px] text-muted">No budget set.</p> : null}
            {budgetLines.map((b) => (
              <div key={b.id} className="flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-[13px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Badge tone={b.standing === 'over' ? 'danger' : b.standing === 'within' ? 'success' : 'neutral'}>{b.standing}</Badge>
                    <span className="font-medium">{b.metric}</span>
                    <span className="text-muted">{b.lowerIsBetter ? 'at most' : 'at least'} {b.target} {b.unit}</span>
                  </span>
                  <span className="text-xs text-muted">{b.latest ? `latest ${b.latest.value} ${b.latest.unit} · ${clock.dateTime(b.latest.recordedAt)}` : 'nothing measured yet'}</span>
                </div>
                {canWrite ? <BudgetForm projectId={projectId} existing={{ metric: b.metric, target: b.target, unit: b.unit, lowerIsBetter: b.lowerIsBetter }} /> : null}
              </div>
            ))}
            {canWrite ? <BudgetForm projectId={projectId} /> : null}
          </div>
        </Card>

        <Card>
          <CardHeader title={`Stability incidents (${incidents.filter((i) => i.resolvedAt === null).length} open)`} description="Outages, crashes and degradations — opened with a severity, resolved with words. Never deleted." />
          <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
            {incidents.length === 0 ? <p className="text-[13px] text-muted">No incident recorded.</p> : null}
            {incidents.slice(0, 20).map((i) => (
              <div key={i.id} className="flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-[13px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Badge tone={i.resolvedAt ? 'neutral' : i.severity === 'critical' || i.severity === 'high' ? 'danger' : 'warning'}>{i.severity}</Badge>
                    <span>{i.summary}</span>
                  </span>
                  <span className="text-xs text-muted">opened {clock.dateTime(i.openedAt)}{i.resolvedAt ? ` · resolved ${clock.dateTime(i.resolvedAt)}` : ''}</span>
                </div>
                {i.resolution ? <p className="text-xs text-muted">{i.resolution}</p> : null}
                {canWrite && !i.resolvedAt ? <ResolveIncidentForm projectId={projectId} incidentId={i.id} /> : null}
              </div>
            ))}
            {canWrite ? <OpenIncidentForm projectId={projectId} /> : null}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title={`Scheduled suites (${schedules.length})`} description="Cron (minute hour day month weekday) in the agency's zone. When due, the tick opens a run against the chosen build for a person or an agent to fill and close — the panel has no test runner." />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {schedules.map((s) => (
            <div key={s.id} className="flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Badge tone={s.active ? 'brand' : 'neutral'}>{s.suite}</Badge>
                  <span>{describeCron(s.cron)}</span>
                  <code className="text-xs text-muted">{s.cron}</code>
                </span>
                <span className="text-xs text-muted">
                  {s.active && s.nextRunAt ? `next ${clock.dateTime(s.nextRunAt)}` : 'paused'}
                  {s.lastRunAt ? ` · last ${clock.dateTime(s.lastRunAt)}` : ''}
                </span>
              </div>
              {canWrite ? <ScheduleSuiteForm projectId={projectId} builds={builds} existing={{ suite: s.suite, cron: s.cron, deliverableId: s.deliverableId, active: s.active }} /> : null}
            </div>
          ))}
          {canWrite ? <ScheduleSuiteForm projectId={projectId} builds={builds} /> : schedules.length === 0 ? <p className="text-[13px] text-muted">No suite is scheduled.</p> : null}
        </div>
      </Card>

      <QaInsights
        projectId={projectId}
        clock={clock}
        runs={runDetails}
        planItems={plan?.items ?? []}
        planVersions={planVersions}
        defects={defects}
        tasks={tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }))}
        history={history}
        roster={roster.map((m) => ({ userId: m.userId, fullName: m.fullName }))}
        builds={deliverables.map((d) => ({ id: d.id, kind: d.kind, version: d.version, title: d.title }))}
        mayWrite={canWrite}
        filter={{ defects: defectsFilter, severity: severityFilter }}
      />
    </div>
    </PreviewDrawerProvider>
  );
}
