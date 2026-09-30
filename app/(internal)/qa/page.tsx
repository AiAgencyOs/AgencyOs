import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { normaliseSearch } from '@/lib/db/search';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { listPerformanceNotes, readCompatibilityMatrix } from '@/modules/qa/compatibility-queries';
import { deviceTiles, PLATFORMS, type Platform } from '@/modules/qa/device-tiles';
import { DeviceTestingCard, QaTeamCard } from '@/modules/qa/qa-device-view';
import { listDeviceRuns, readQaTeam } from '@/modules/qa/qa-team-queries';
import { listReleaseHolds } from '@/modules/projects/release-hold-queries';
import { listRetestQueue, readCoverageMatrix } from '@/modules/qa/dashboard-queries';
import { listOpenDefects, readOrgTestCoverage, readSuiteCoverage, type OpenDefect } from '@/modules/qa/queries';
import { listInternalRoster, listProjects } from '@/modules/projects/queries';
import { describeCron } from '@/modules/qa/cron';
import { listSuiteSchedules } from '@/modules/qa/schedule-queries';
import { listRecentRuns, listReleaseCandidates, readBugTrend, readOrgEvidenceSummary } from '@/modules/qa/summary-queries';

import { AssignRetestForm, BlockReleaseFromDashboard } from './qa-forms';
import {
  buttonClass,
  Avatar,
  Badge,
  Card,
  CardHeader,
  DataTable,
  DonutChart,
  EmptyState,
  humanize,
  IconAlert,
  IconCheck,
  IconClock,
  IconList,
  IconProjects,
  PageHeader,
  PermissionDenied,
  ProgressBar,
  QuickActions,
  Stat,
  StatGrid,
  TrendChart,
  ViewAll,
  type Column,
  type Tone,
  DomainSearch,
  SearchSummary,
} from '@/ui';

export const metadata: Metadata = { title: 'QA' };

const SEVERITY_TONE: Record<string, Tone> = { blocker: 'danger', major: 'warning', minor: 'info', trivial: 'neutral' };

function countBy(defects: OpenDefect[], severity: string): number {
  return defects.filter((d) => d.severity === severity).length;
}

/**
 * QA Dashboard — SCR-044, laid out as the reference's QA screen: figures for
 * runs and outcomes, the suite table, the QA-progress donut, open bugs with
 * severity and project, and quick actions. The org-wide view `qa.defects`
 * never had. Test plans and test runs (SCR-045/046) have a real reader and
 * writer of their own on each project's QA panel; this dashboard adds the
 * org-wide coverage question that panel can't answer on its own — how many
 * projects have a plan at all, and how much testing has actually run
 * recently — alongside the defect list. The device × browser matrix is
 * drawn from what compatibility runs recorded (`qa.test_runs.device` /
 * `browser` / `os`, 20260929170000) and nothing else: a run that did not say
 * where it ran is counted beside the grid, not placed in it.
 *
 * Gated on project.read, same as the per-project QA panel this aggregates —
 * no new capability, and no client ever reaches this (Doc 14: "a client is
 * told what was fixed, not what is currently broken").
 */
export default async function QaDashboardPage({ searchParams }: { searchParams: Promise<{ q?: string; platform?: string }> }) {
  const context = await requireInternal('/qa');
  const clock = await agencyClock();
  if (!can(context, 'project.read')) return <PermissionDenied />;
  // Search within domain (bucket G-3): the bug list, by title or environment, filtered by the reader.
  const { q: qRaw, platform: platformRaw } = await searchParams;
  const platform = (PLATFORMS as readonly string[]).includes(platformRaw ?? '') ? (platformRaw as Platform) : null;
  const q = normaliseSearch(qRaw);

  const [defects, coverage, suiteCoverage, matrix, retest, compat, perfNotes, holds] = await Promise.all([
    listOpenDefects(300, q || undefined),
    readOrgTestCoverage(),
    readSuiteCoverage(),
    readCoverageMatrix(),
    listRetestQueue(),
    readCompatibilityMatrix(),
    listPerformanceNotes(),
    // SCR-044 — a standing release hold shows as "held" in the readiness column.
    listReleaseHolds(),
  ]);
  // SCR-044 (bucket F): recent runs, the bug trend, the release candidate per
  // project, org-wide evidence, schedules, and the roster the retest form needs.
  const mayWrite = can(context, 'project.write');
  const maySignOff = can(context, 'project.sign_off');
  const [recentRuns, trend, candidates, evidence, schedules, roster, projects, deviceRuns, qaTeam] = await Promise.all([
    listRecentRuns(25),
    readBugTrend(12),
    listReleaseCandidates(),
    readOrgEvidenceSummary(),
    listSuiteSchedules(),
    mayWrite ? listInternalRoster() : Promise.resolve([]),
    maySignOff ? listProjects(500) : Promise.resolve([]),
    listDeviceRuns(),
    readQaTeam(),
  ]);
  const tiles = deviceTiles(deviceRuns);
  const candidateByProject = new Map(candidates.map((c) => [c.projectId, c]));
  const trendRows = trend.map((p) => ({ week: p.week.slice(5), raised: p.raised, settled: p.settled }));
  const blockers = countBy(defects, 'blocker');
  const majors = countBy(defects, 'major');
  const runs = coverage.runsLast30Days;
  // A run records several item results, so passed + failed is the outcome
  // count, not the run count; the rate is over outcomes.
  const outcomes = coverage.passedLast30Days + coverage.failedLast30Days;
  const passRate = outcomes > 0 ? Math.round((coverage.passedLast30Days / outcomes) * 100) : null;

  const columns: Column<OpenDefect>[] = [
    {
      key: 'title',
      header: 'Bug',
      primary: true,
      cell: (d) => (
        <>
          <span className="block truncate">{d.title}</span>
          <span className="block truncate text-xs font-normal text-muted">{d.reproduction}</span>
        </>
      ),
    },
    {
      key: 'project',
      header: 'Project',
      desktopOnly: true,
      cell: (d) => (
        <span className="flex items-center gap-2 text-muted">
          <Avatar name={d.projectName} size="sm" square tone="sidebar" />
          <span className="truncate">{d.projectName}</span>
        </span>
      ),
    },
    { key: 'severity', header: 'Severity', badge: true, cell: (d) => <Badge tone={SEVERITY_TONE[d.severity] ?? 'neutral'}>{humanize(d.severity)}</Badge> },
    { key: 'environment', header: 'Environment', desktopOnly: true, cellClassName: 'text-muted', cell: (d) => d.environment ?? '—' },
    { key: 'raised', header: 'Raised', align: 'right', cellClassName: 'text-muted whitespace-nowrap', cell: (d) => clock.date(d.created_at) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="QA & Testing"
        description="Test runs, suite coverage and every open defect across all projects — most severe first."
        actions={<LiveRefresh topics={['qa', 'deliverables']} />}
      />

      <StatGrid cols={5}>
        <Stat label="Runs (30 days)" value={String(runs)} caption={`${coverage.projectsWithPlan}/${coverage.totalProjects} projects have a test plan`} tone="brand" icon={<IconList size={16} />} />
        <Stat label="Passed" value={String(coverage.passedLast30Days)} caption={passRate === null ? 'No results recorded' : `${passRate}% of ${outcomes} result${outcomes === 1 ? '' : 's'}`} tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Failed" value={String(coverage.failedLast30Days)} caption="Last 30 days" tone={coverage.failedLast30Days > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} />
        <Stat label="Open blockers" value={String(blockers)} caption={`${majors} major`} tone={blockers > 0 ? 'danger' : majors > 0 ? 'warning' : 'success'} icon={<IconAlert size={16} />} />
        <Stat label="Open defects" value={String(defects.length)} caption="Not yet verified" tone={defects.length > 0 ? 'warning' : 'success'} icon={<IconClock size={16} />} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(19rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* SCR-044 (bucket F): recent runs, org-wide — open first, each linking to its run, its build and its project. */}
          <Card>
            <CardHeader title="Test Runs" description={`${evidence.openRuns} open across every project. A run is opened against a build, closed once with its counts, and rerun by pointing a new run at it.`} />
            {recentRuns.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No test run recorded yet.</p>
            ) : (
              <div className="px-4 pb-4 sm:px-5">
                <DataTable
                  dense
                  rows={recentRuns}
                  columns={[
                    {
                      key: 'run',
                      header: 'Run',
                      primary: true,
                      cell: (r) => (
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone={r.status === 'open' ? 'warning' : r.failed > 0 || r.blocked > 0 ? 'danger' : 'success'}>{r.status}</Badge>
                          <Link href={`/projects/${r.projectId}/qa#run-${r.id}`} className="font-medium hover:underline">{humanize(r.suite)}</Link>
                          {r.rerunOf ? <span className="text-xs text-muted">rerun</span> : null}
                        </span>
                      ),
                    },
                    { key: 'project', header: 'Project', desktopOnly: true, cellClassName: 'text-muted', cell: (r) => <Link href={`/projects/${r.projectId}/qa`} className="hover:underline">{r.projectName}</Link> },
                    { key: 'build', header: 'Build', cellClassName: 'text-muted', cell: (r) => <Link href={`/projects/${r.projectId}/builds`} className="font-mono text-xs hover:underline">{r.deliverableVersion !== null ? `v${r.deliverableVersion}` : 'build'}</Link> },
                    { key: 'counts', header: 'Pass / fail / blocked', align: 'right', cellClassName: 'tabular', cell: (r) => (r.status === 'open' ? <span className="text-muted">in progress</span> : `${r.passed} / ${r.failed} / ${r.blocked}${r.skipped > 0 ? ` (+${r.skipped} skipped)` : ''}`) },
                    { key: 'when', header: 'Started · ended', align: 'right', desktopOnly: true, cellClassName: 'text-muted whitespace-nowrap', cell: (r) => `${clock.dateTime(r.startedAt ?? r.executedAt)}${r.endedAt ? ` · ${clock.dateTime(r.endedAt)}` : ''}` },
                  ]}
                  getKey={(r) => r.id}
                />
              </div>
            )}
          </Card>

          <DeviceTestingCard
            tiles={tiles}
            active={platform}
            hrefFor={(p) => (p ? `/qa?platform=${p}#device-testing` : '/qa#device-testing')}
            addHref="/projects"
            date={(iso) => clock.date(iso)}
          />

          {compat.devices.length > 0 ? (
            <Card>
              <CardHeader
                title="Device × Browser"
                description={`From compatibility-suite runs in the last 90 days. Each cell is runs recorded and tests failed — a report, not a gate.${compat.unplaced > 0 ? ` ${compat.unplaced} run${compat.unplaced === 1 ? '' : 's'} recorded no device or browser and sit${compat.unplaced === 1 ? 's' : ''} outside the grid.` : ''}`}
              />
              <div className="overflow-x-auto px-4 pb-4 sm:px-5">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                      <th className="py-2 pr-3">Device</th>
                      {compat.browsers.map((b) => (
                        <th key={b} className="py-2 pr-3 text-right">{b}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {compat.devices.map((d) => (
                      <tr key={d} className="border-b border-line last:border-0">
                        <td className="py-2 pr-3 font-medium">{d}</td>
                        {compat.browsers.map((b) => {
                          const cell = compat.cells.get(`${d}|${b}`);
                          return (
                            <td key={b} className="py-2 pr-3 text-right tabular">
                              {cell ? (
                                <span className={cell.failed > 0 ? 'text-danger' : 'text-success'}>
                                  {cell.runs} run{cell.runs === 1 ? '' : 's'} · {cell.failed} failed
                                </span>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
          </Card>
          ) : null}

          <Card>
            <CardHeader title="Test suites" description="Regression, compatibility and performance — the last 30 days, across every project." />
            <ul className="divide-y divide-line">
              {suiteCoverage.map((s) => {
                const rate = s.runsLast30Days > 0 ? Math.round((s.passedLast30Days / s.runsLast30Days) * 100) : null;
                return (
                  <li key={s.suite} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                    <span className="w-32 shrink-0 text-[13px] font-medium">{humanize(s.suite)}</span>
                    <span className="min-w-[10rem] flex-1">
                      {rate === null ? <span className="text-xs text-muted">No runs recorded</span> : <ProgressBar value={rate} label={`${s.suite} pass rate`} tone={rate >= 80 ? 'success' : rate >= 50 ? 'warning' : 'danger'} />}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs">
                      <Badge tone="neutral">{s.runsLast30Days} run{s.runsLast30Days === 1 ? '' : 's'}</Badge>
                      {s.runsLast30Days > 0 ? (
                        <>
                          <Badge tone="success">{s.passedLast30Days} passed</Badge>
                          <Badge tone={s.failedLast30Days > 0 ? 'danger' : 'neutral'}>{s.failedLast30Days} failed</Badge>
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card>
            <CardHeader title={`Open bugs (${defects.length})`} description="Open a bug for its page — reproduction, evidence, linked task and build, and its fix / retest history (SCR-047)." actions={<ViewAll href="/projects" label="Projects" />} />
            {/* Search within domain (bucket G-3): the bug list by title or environment, filtered by the reader. */}
            <div className="flex flex-col gap-2 px-4 pb-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-5">
              <DomainSearch action="/qa" value={q} placeholder="Search bug title or environment…" label="Search open bugs" />
              <SearchSummary q={q} count={defects.length} clearHref="/qa" />
            </div>
            {defects.length > 0 ? (
              <div className="px-4 pb-4 sm:px-5">
                <DataTable dense rows={defects} columns={columns} getKey={(d) => d.id} href={(d) => `/projects/${d.projectId}/qa/bugs/${d.id}`} />
              </div>
            ) : (
              <EmptyState
                icon={<IconCheck size={22} />}
                title={q ? 'No matching open defect' : 'No open defects'}
                description={q ? `No open defect matches ‘${q}’.` : 'Every raised defect has been fixed, waived, or is not currently blocking anything.'}
                action={q ? <Link href="/qa" className={buttonClass('secondary', 'sm')}>Clear search</Link> : <Link href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</Link>}
              />
            )}
          </Card>

          {/* SCR-044 (bucket F): bug trend — raised and settled per week, from qa.defects; the two lines are direct-labelled by the legend and read as counts. */}
          <Card>
            <CardHeader title="Bug trend" description="Defects raised and settled (verified or won't-fix) per week, last 12 weeks. Counts of rows, UTC weeks starting Monday." />
            <div className="p-4 sm:p-5">
              {trend.every((p) => p.raised === 0 && p.settled === 0) ? (
                <p className="text-[13px] text-muted">No defect raised or settled in the last 12 weeks.</p>
              ) : (
                <TrendChart data={trendRows} xKey="week" series={[{ key: 'raised', label: 'Raised', color: 'var(--danger)' }, { key: 'settled', label: 'Settled', color: 'var(--success)' }]} height={200} />
              )}
              <p className="mt-2 text-xs text-muted">Open at the end of the last week: {trend[trend.length - 1]?.openAtEnd ?? 0}.</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Coverage matrix" description="Test-plan items per category, by project — a report of what is planned, not a gate. Readiness and retest columns are the project's own figures." />
            {matrix.rows.length === 0 ? (
              <EmptyState icon={<IconList size={22} />} title="No test plans yet" description="A row appears once a project drafts a test plan against a frozen scope." action={<Link href="/requirements" className={buttonClass('secondary', 'sm')}>Open requirements</Link>} />
            ) : (
              <div className="overflow-x-auto px-4 pb-4 sm:px-5">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                      <th className="py-2 pr-3">Project</th>
                      {matrix.categories.map((c) => (
                        <th key={c} className="py-2 pr-3 text-right">{humanize(c)}</th>
                      ))}
                      <th className="py-2 pr-3 text-right">Total</th>
                      <th className="py-2 pr-3 text-right">RC</th>
                      <th className="py-2 pr-3 text-right">Retest</th>
                      <th className="py-2 pr-3 text-right">Blocking</th>
                      <th className="py-2 text-right">Ready</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.rows.map((r) => (
                      <tr key={r.projectId} className="border-b border-line last:border-0">
                        <td className="py-2 pr-3">
                          <Link href={`/projects/${r.projectId}/qa`} className="font-medium hover:underline">{r.projectName}</Link>
                          {r.scopeVersion !== null ? <span className="ml-1 text-xs text-muted">scope v{r.scopeVersion}</span> : null}
                        </td>
                        {matrix.categories.map((c) => (
                          <td key={c} className="py-2 pr-3 text-right tabular text-muted">{r.counts[c] ?? 0}</td>
                        ))}
                        <td className="py-2 pr-3 text-right tabular font-medium">{r.total}</td>
                        {/* SCR-044 (bucket F): the release candidate — the latest build — and a link to it. */}
                        <td className="py-2 pr-3 text-right">
                          {candidateByProject.get(r.projectId) ? (
                            <Link href={`/projects/${r.projectId}/builds`} className="font-mono text-xs hover:underline" title={candidateByProject.get(r.projectId)!.title}>v{candidateByProject.get(r.projectId)!.version}</Link>
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </td>
                        <td className={`py-2 pr-3 text-right tabular ${r.awaitingRetest > 0 ? 'text-warning' : 'text-muted'}`}>{r.awaitingRetest}</td>
                        <td className={`py-2 pr-3 text-right tabular ${r.openBlocking > 0 ? 'text-danger' : 'text-muted'}`}>{r.openBlocking}</td>
                        <td className="py-2 text-right">
                          {r.productionReadyAt ? (
                            <Badge tone="success">ready</Badge>
                          ) : holds.has(r.projectId) ? (
                            <span title={holds.get(r.projectId)}><Badge tone="danger">held</Badge></span>
                          ) : (
                            <Badge tone="neutral">not yet</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Performance notes" description="What performance-suite runs measured, in the tester's words. No target is applied — Doc 14 §16 says targets are project-specific and none is configured." />
            {perfNotes.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No performance run has recorded notes.</p>
            ) : (
              <ul className="divide-y divide-line">
                {perfNotes.map((n) => (
                  <li key={n.runId} className="flex flex-col gap-1 px-4 py-2 text-[13px] sm:px-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={`/projects/${n.projectId}/qa`} className="font-medium hover:underline">{n.projectName}</Link>
                      <span className="text-xs text-muted">
                        {n.passed}/{n.total} passed{n.failed > 0 ? ` · ${n.failed} failed` : ''}{n.device ? ` · ${n.device}` : ''} · {clock.date(n.executedAt)}
                      </span>
                    </div>
                    <p className="whitespace-pre-line text-muted">{n.perfNotes}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title={`Retest queue (${retest.length})`} description="Defects marked fixed and waiting for somebody to verify them, oldest fix first. Verify on the project's Quality section." />
            {retest.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing is waiting for a retest.</p>
            ) : (
              <ul className="divide-y divide-line">
                {retest.slice(0, 20).map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge tone={d.severity === 'blocker' ? 'danger' : d.severity === 'major' ? 'warning' : 'neutral'}>{d.severity}</Badge>
                      <Link href={`/projects/${d.projectId}/qa/bugs/${d.id}`} className="truncate font-medium hover:underline">{d.title}</Link>
                      <span className="text-xs text-muted">{d.projectName}</span>
                    </span>
                    <span className="text-xs text-muted">{d.assignee_id ? 'assigned' : 'unassigned'} · raised {clock.date(d.created_at)}</span>
                    {/* SCR-044 (bucket F): assign the retest from here — qa.assign_retest, the project page's own door. */}
                    {mayWrite ? <span className="w-full"><AssignRetestForm projectId={d.projectId} defectId={d.id} roster={roster.map((m) => ({ userId: m.userId, fullName: m.fullName || m.email }))} currentAssigneeId={d.assignee_id} /></span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="QA Progress" description={`Item results across ${runs} run${runs === 1 ? '' : 's'} in the last 30 days.`} />
            <div className="p-4 sm:p-5">
              {outcomes === 0 ? (
                <p className="text-[13px] text-muted">No test results recorded in the last 30 days.</p>
              ) : (
                <DonutChart
                  data={[
                    { label: 'Passed', value: coverage.passedLast30Days },
                    { label: 'Failed', value: coverage.failedLast30Days },
                  ]}
                  colors={['var(--success)', 'var(--danger)']}
                  totalLabel="Results"
                  height={150}
                />
              )}
            </div>
          </Card>

          <QaTeamCard team={qaTeam} manageHref={qaTeam[0]?.projects[0] ? `/projects/${qaTeam[0].projects[0].id}/team` : null} />

          <Card>
            <CardHeader title="Defects by severity" />
            <ul className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
              {(['blocker', 'major', 'minor', 'trivial'] as const).map((s) => (
                <li key={s} className="flex items-center justify-between text-[13px]">
                  <Badge tone={SEVERITY_TONE[s] ?? 'neutral'}>{humanize(s)}</Badge>
                  <span className="tabular text-muted">{countBy(defects, s)}</span>
                </li>
              ))}
            </ul>
          </Card>

          <QuickActions
            title="Quick Actions"
            actions={[
              { label: 'Projects', icon: <IconProjects size={13} />, href: '/projects' },
              { label: 'Production readiness', icon: <IconCheck size={13} />, href: '/production-readiness' },
              { label: 'Approvals', icon: <IconClock size={13} />, href: '/approvals' },
              { label: 'Reports', icon: <IconList size={13} />, href: '/reports' },
            ]}
          />
          {/* SCR-044 (bucket F): the org-wide QA evidence summary — every figure a count of rows; the per-project CSV stays on each project's QA page. */}
          <Card>
            <CardHeader title="QA evidence summary" description="Org-wide, all time. The per-project evidence CSV is on each project's QA page." />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 pb-4 text-[13px] sm:px-5">
              <div><dt className="text-xs text-muted">Projects with runs or bugs</dt><dd className="tabular font-medium">{evidence.projects}</dd></div>
              <div><dt className="text-xs text-muted">Runs</dt><dd className="tabular font-medium">{evidence.runs} <span className="text-xs font-normal text-muted">({evidence.openRuns} open)</span></dd></div>
              <div><dt className="text-xs text-muted">Runs with evidence</dt><dd className="tabular font-medium">{evidence.runsWithEvidence}</dd></div>
              <div><dt className="text-xs text-muted">Passed / failed / blocked</dt><dd className="tabular font-medium">{evidence.passed} / {evidence.failed} / {evidence.blocked}</dd></div>
              <div><dt className="text-xs text-muted">Defects raised</dt><dd className="tabular font-medium">{evidence.defectsRaised}</dd></div>
              <div><dt className="text-xs text-muted">Defects verified</dt><dd className="tabular font-medium">{evidence.defectsVerified}</dd></div>
              <div><dt className="text-xs text-muted">Open stability incidents</dt><dd className={`tabular font-medium ${evidence.incidentsOpen > 0 ? 'text-danger' : ''}`}>{evidence.incidentsOpen}</dd></div>
            </dl>
            {evidence.byProject.length > 0 ? (
              <ul className="divide-y divide-line border-t border-line">
                {evidence.byProject.slice(0, 12).map((p) => (
                  <li key={p.projectId} className="flex items-center justify-between gap-2 px-4 py-1.5 text-xs sm:px-5">
                    <Link href={`/projects/${p.projectId}/qa`} className="truncate hover:underline">{p.projectName}</Link>
                    <span className="shrink-0 tabular text-muted">{p.runs} runs · {p.failed} failed · {p.defectsOpen} open</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          {/* SCR-048 (bucket F): suite schedules the tick fires, across projects. */}
          <Card>
            <CardHeader title={`Scheduled suites (${schedules.length})`} description="Cron in the agency's zone. When due, the tick OPENS a run against the scheduled build — the panel has no test runner." />
            {schedules.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No suite is scheduled. Schedule one on a project's QA page.</p>
            ) : (
              <ul className="divide-y divide-line">
                {schedules.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
                    <span className="flex items-center gap-2">
                      <Badge tone={s.active ? 'brand' : 'neutral'}>{humanize(s.suite)}</Badge>
                      <Link href={`/projects/${s.projectId}/qa`} className="text-xs text-muted hover:underline">{describeCron(s.cron)}</Link>
                    </span>
                    <span className="text-xs text-muted">{s.active && s.nextRunAt ? `next ${clock.dateTime(s.nextRunAt)}` : 'paused'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* SCR-044 (bucket F): block a release from the dashboard — the Release tab's own hold door, one implementation. */}
          {maySignOff ? (
            <Card>
              <CardHeader title="Block a release" description="Puts a release hold on a project: production sign-off is refused, quoting your reason, until it is lifted on the project's Release tab. Audited." />
              <div className="px-4 pb-4 sm:px-5">
                <BlockReleaseFromDashboard projects={projects.map((p) => ({ id: p.id, name: p.name, held: holds.has(p.id) }))} />
              </div>
            </Card>
          ) : null}

          {defects[0] ? (
            <Card>
              <CardHeader title="Most severe open" />
              <div className="px-4 pb-4 text-[13px] sm:px-5">
                <Link href={`/projects/${defects[0].projectId}/qa/bugs/${defects[0].id}`} className="font-medium text-foreground hover:text-brand">
                  {defects[0].title}
                </Link>
                <p className="text-xs text-muted">{defects[0].projectName} · {humanize(defects[0].severity)} · raised {clock.date(defects[0].created_at)}</p>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
