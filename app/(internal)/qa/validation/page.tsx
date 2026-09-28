import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  listRetestQueue,
  listUiValidations,
  readOrgReadiness,
  readSuiteCoverage,
} from '@/modules/qa/queries';
import { Badge, Card, EmptyState, humanize, IconCheck, PageHeader, Stat, StatGrid, statusTone } from '@/ui';

export const metadata: Metadata = { title: 'QA Validation' };

function when(clock: AgencyClock, value: string): string {
  return clock.date(value);
}

/**
 * P4-QAP-ADMINUI, remaining surfaces — Validation Matrix, Retests,
 * Regression and Readiness. `/qa` already carries the org-wide open-defect
 * list and the 30-day test-run rollup (SCR-044/048); this is the four
 * surfaces that page never took on: the per-UI-version QA verdict across
 * every project (`listUiValidations`), the fixed-but-unverified queue every
 * defect eventually passes through (`listRetestQueue`), the regression
 * suite's own share of `readSuiteCoverage`'s three-suite rollup, and a
 * per-project ready-to-ship rollup derived from the same `qa.defects` rows
 * `qa.project_quality` already reduces per project (`readOrgReadiness`).
 *
 * Read-only, gated on `project.read` like `/qa` itself — this shows what QA
 * already decided, through `handleReviewUIVersion`/`handleReviewPrototypeBuild`
 * and the defect lifecycle guard, never a second verdict.
 */
export default async function QaValidationPage() {
  const context = await requireInternal('/qa/validation');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const [validations, retests, readiness, suiteCoverage] = await Promise.all([
    listUiValidations(),
    listRetestQueue(),
    readOrgReadiness(),
    readSuiteCoverage(),
  ]);

  const regression = suiteCoverage.find((s) => s.suite === 'regression') ?? null;
  const notReady = readiness.filter((r) => !r.ready);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="QA Validation"
        description="The UI/prototype validation matrix, the retest queue, regression coverage and per-project readiness — across every project."
      />

      <StatGrid>
        <Stat label="UI versions reviewed" value={String(validations.length)} />
        <Stat label="Awaiting retest" value={String(retests.length)} tone={retests.length > 0 ? 'warning' : 'success'} />
        <Stat
          label="Regression runs (30d)"
          value={String(regression?.runsLast30Days ?? 0)}
          tone={regression && regression.failedLast30Days > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label="Projects not ready"
          value={String(notReady.length)}
          tone={notReady.length > 0 ? 'danger' : 'success'}
        />
      </StatGrid>

      <Card className="p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Validation matrix — UI versions</h2>
        {validations.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2">
            {validations.map((v) => (
              <li key={`${v.projectId}-${v.version}`} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <span className="flex items-center gap-2">
                  <Link href={`/projects/${v.projectId}`} className="font-medium underline-offset-2 hover:underline">
                    {v.projectName}
                  </Link>
                  <span className="text-muted">v{v.version}</span>
                  <Badge tone={statusTone(v.status)}>{humanize(v.status)}</Badge>
                </span>
                <span className="text-xs text-muted">
                  {v.missingScreens > 0 || v.stateGaps > 0
                    ? `${v.missingScreens} missing screen(s), ${v.stateGaps} state gap(s)`
                    : v.qaReviewedAt
                      ? 'clear'
                      : 'not reviewed'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[13px] text-muted">No UI version has been drafted yet.</p>
        )}
      </Card>

      <Card className="p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Retest queue — fixed, not yet verified</h2>
        {retests.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2">
            {retests.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <span className="flex items-center gap-2">
                  <Badge tone={d.severity === 'blocker' ? 'danger' : d.severity === 'major' ? 'warning' : 'neutral'}>
                    {d.severity}
                  </Badge>
                  <Link href={`/projects/${d.projectId}`} className="underline-offset-2 hover:underline">
                    {d.projectName}
                  </Link>
                  <span>{d.title}</span>
                </span>
                <span className="text-xs text-muted">{when(clock, d.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<IconCheck size={18} />} title="Nothing waiting on a retest" />
        )}
      </Card>

      <Card className="p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Readiness by project</h2>
        {readiness.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2">
            {readiness.map((r) => (
              <li key={r.projectId} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <Link href={`/projects/${r.projectId}`} className="font-medium underline-offset-2 hover:underline">
                  {r.projectName}
                </Link>
                <span className="flex items-center gap-2 text-xs">
                  <Badge tone={r.ready ? 'success' : 'danger'}>{r.ready ? 'ready' : 'not ready'}</Badge>
                  {!r.ready ? (
                    <span className="text-muted">
                      {r.openBlockers} blocker(s), {r.openMajors} major(s), {r.unverified} unverified
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[13px] text-muted">No project has an open or fixed defect recorded.</p>
        )}
      </Card>
    </div>
  );
}
