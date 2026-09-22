import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listOpenDefects, readOrgTestCoverage, readSuiteCoverage, type OpenDefect } from '@/modules/qa/queries';
import { Badge, Card, EmptyState, IconCheck, PageHeader, Stat, StatGrid, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'QA' };

const SEVERITY_TONE: Record<string, Tone> = {
  blocker: 'danger',
  major: 'warning',
  minor: 'neutral',
  trivial: 'neutral',
};

function when(clock: AgencyClock, value: string): string {
  return clock.date(value);
}

function countBy(defects: OpenDefect[], severity: string): number {
  return defects.filter((d) => d.severity === severity).length;
}

/**
 * QA Dashboard — SCR-044, the org-wide view `qa.defects` never had. Test
 * plans and test runs (SCR-045/046 — qa.test_plans, .test_plan_items,
 * .test_runs) have a real reader and writer of their own on each project's
 * QA panel (`projects/[projectId]/qa/page.tsx`: `TestPlanCard`,
 * `TestRunsCard`, `DraftTestPlanForm`); this dashboard adds the org-wide
 * coverage question that panel can't answer on its own — how many projects
 * have a plan at all, and how much testing has actually run recently —
 * alongside the defect list, which stays the one thing worth reading in
 * full at this scope. `readSuiteCoverage` (SCR-048) breaks the same 30-day
 * window out by regression/compatibility/performance specifically, since
 * `qa.defects` carries no category and those three are otherwise folded
 * into the aggregate above.
 *
 * Gated on project.read, same as the per-project QA panel this aggregates —
 * no new capability, and no client ever reaches this (Doc 14: "a client is
 * told what was fixed, not what is currently broken").
 */
export default async function QaDashboardPage() {
  const context = await requireInternal('/qa');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const [defects, coverage, suiteCoverage] = await Promise.all([
    listOpenDefects(),
    readOrgTestCoverage(),
    readSuiteCoverage(),
  ]);
  const blockers = countBy(defects, 'blocker');
  const majors = countBy(defects, 'major');
  const minors = countBy(defects, 'minor');
  const trivials = countBy(defects, 'trivial');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="QA"
        description={
          defects.length === 0
            ? 'No open defects across any project.'
            : `${defects.length} open defect${defects.length === 1 ? '' : 's'} across every project, most severe first.`
        }
      />

      <StatGrid>
        <Stat label="Blockers" value={String(blockers)} tone={blockers > 0 ? 'danger' : 'success'} />
        <Stat label="Major" value={String(majors)} tone={majors > 0 ? 'warning' : 'success'} />
        <Stat label="Minor" value={String(minors)} />
        <Stat label="Trivial" value={String(trivials)} />
      </StatGrid>

      <StatGrid>
        <Stat
          label="Projects with a test plan"
          value={`${coverage.projectsWithPlan} / ${coverage.totalProjects}`}
          tone={coverage.projectsWithPlan < coverage.totalProjects ? 'warning' : 'success'}
        />
        <Stat label="Runs in last 30 days" value={String(coverage.runsLast30Days)} />
        <Stat label="Passed (30d)" value={String(coverage.passedLast30Days)} tone="success" />
        <Stat
          label="Failed (30d)"
          value={String(coverage.failedLast30Days)}
          tone={coverage.failedLast30Days > 0 ? 'danger' : 'success'}
        />
      </StatGrid>

      <Card className="p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Regression, compatibility &amp; performance — last 30 days</h2>
        <ul className="mt-3 flex flex-col gap-2">
          {suiteCoverage.map((s) => (
            <li key={s.suite} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <span className="flex items-center gap-2">
                <Badge tone="neutral">{s.suite}</Badge>
                {s.runsLast30Days === 0 ? (
                  <span className="text-muted">no runs recorded</span>
                ) : (
                  <span className="text-muted">
                    {s.runsLast30Days} run{s.runsLast30Days === 1 ? '' : 's'}
                  </span>
                )}
              </span>
              {s.runsLast30Days > 0 ? (
                <span className="flex items-center gap-2">
                  <Badge tone="success">{s.passedLast30Days} passed</Badge>
                  <Badge tone={s.failedLast30Days > 0 ? 'danger' : 'neutral'}>{s.failedLast30Days} failed</Badge>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {defects.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {defects.map((d) => (
            <li key={d.id}>
              <Card className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-baseline gap-2 text-sm font-semibold">
                      <Badge tone={SEVERITY_TONE[d.severity] ?? 'neutral'}>{d.severity}</Badge>
                      {d.title}
                    </span>
                    <span className="text-[13px] text-muted">
                      <Link href={`/projects/${d.projectId}`} className="underline-offset-2 hover:underline">
                        {d.projectName}
                      </Link>
                      {' · raised '}
                      {when(clock, d.created_at)}
                    </span>
                  </span>
                </div>
                <p className="mt-2 text-[13px] text-muted">
                  <span className="font-medium text-foreground">Reproduction: </span>
                  {d.reproduction}
                </p>
                {d.expected || d.actual ? (
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-2">
                    {d.expected ? (
                      <div>
                        <dt className="text-muted">Expected</dt>
                        <dd>{d.expected}</dd>
                      </div>
                    ) : null}
                    {d.actual ? (
                      <div>
                        <dt className="text-muted">Actual</dt>
                        <dd>{d.actual}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<IconCheck size={22} />}
          title="No open defects"
          description="Every raised defect has been fixed, waived, or is not currently blocking anything."
        />
      )}
    </div>
  );
}
