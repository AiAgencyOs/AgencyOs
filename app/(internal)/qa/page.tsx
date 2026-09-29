import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { listOpenDefects, readOrgTestCoverage, readSuiteCoverage, type OpenDefect } from '@/modules/qa/queries';
import {
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
  ViewAll,
  type Column,
  type Tone,
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
 * recently — alongside the defect list. No device matrix is drawn: nothing
 * in the schema records devices, and a grid of phones would be decoration.
 *
 * Gated on project.read, same as the per-project QA panel this aggregates —
 * no new capability, and no client ever reaches this (Doc 14: "a client is
 * told what was fixed, not what is currently broken").
 */
export default async function QaDashboardPage() {
  const context = await requireInternal('/qa');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const [defects, coverage, suiteCoverage] = await Promise.all([listOpenDefects(), readOrgTestCoverage(), readSuiteCoverage()]);
  const blockers = countBy(defects, 'blocker');
  const majors = countBy(defects, 'major');
  const runs = coverage.runsLast30Days;
  const passRate = runs > 0 ? Math.round((coverage.passedLast30Days / runs) * 100) : null;
  const other = Math.max(0, runs - coverage.passedLast30Days - coverage.failedLast30Days);

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
          <Avatar name={d.projectName} size="sm" square tone="neutral" className="bg-sidebar-bg text-sidebar-fg ring-0" />
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
        title="QA & testing"
        description="Test runs, suite coverage and every open defect across all projects — most severe first."
        actions={<LiveRefresh topics={['qa', 'deliverables']} />}
      />

      <StatGrid cols={5}>
        <Stat label="Runs (30 days)" value={String(runs)} caption={`${coverage.projectsWithPlan}/${coverage.totalProjects} projects have a test plan`} tone="brand" icon={<IconList size={16} />} />
        <Stat label="Passed" value={String(coverage.passedLast30Days)} caption={passRate === null ? 'No runs recorded' : `${passRate}% pass rate`} tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Failed" value={String(coverage.failedLast30Days)} caption="Last 30 days" tone={coverage.failedLast30Days > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} />
        <Stat label="Open blockers" value={String(blockers)} caption={`${majors} major`} tone={blockers > 0 ? 'danger' : majors > 0 ? 'warning' : 'success'} icon={<IconAlert size={16} />} />
        <Stat label="Open defects" value={String(defects.length)} caption="Not yet verified" tone={defects.length > 0 ? 'warning' : 'success'} icon={<IconClock size={16} />} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(19rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
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
            <CardHeader title={`Open bugs (${defects.length})`} description="Open the project to settle a defect on its Quality section." actions={<ViewAll href="/projects" label="Projects" />} />
            {defects.length > 0 ? (
              <div className="px-4 pb-4 sm:px-5">
                <DataTable dense rows={defects} columns={columns} getKey={(d) => d.id} href={(d) => `/projects/${d.projectId}`} />
              </div>
            ) : (
              <EmptyState icon={<IconCheck size={22} />} title="No open defects" description="Every raised defect has been fixed, waived, or is not currently blocking anything." />
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="QA progress" description="Run outcomes in the last 30 days." />
            <div className="p-4 sm:p-5">
              {runs === 0 ? (
                <p className="text-[13px] text-muted">No test runs recorded in the last 30 days.</p>
              ) : (
                <DonutChart
                  data={[
                    { label: 'Passed', value: coverage.passedLast30Days },
                    { label: 'Failed', value: coverage.failedLast30Days },
                    ...(other > 0 ? [{ label: 'Other', value: other }] : []),
                  ]}
                  colors={['var(--success)', 'var(--danger)', 'var(--faint)']}
                  totalLabel="Runs"
                  height={150}
                />
              )}
            </div>
          </Card>

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
            actions={[
              { label: 'Projects', icon: <IconProjects size={13} />, href: '/projects' },
              { label: 'Production readiness', icon: <IconCheck size={13} />, href: '/production-readiness' },
              { label: 'Approvals', icon: <IconClock size={13} />, href: '/approvals' },
              { label: 'Reports', icon: <IconList size={13} />, href: '/reports' },
            ]}
          />
          {defects[0] ? (
            <Card>
              <CardHeader title="Most severe open" />
              <div className="px-4 pb-4 text-[13px] sm:px-5">
                <Link href={`/projects/${defects[0].projectId}`} className="font-medium text-foreground hover:text-brand">
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
