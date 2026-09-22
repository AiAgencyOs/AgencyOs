import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listOpenDefects, type OpenDefect } from '@/modules/qa/queries';
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
 * .test_runs) since gained a real reader and writer of their own on each
 * project's QA panel (`projects/[projectId]/qa/page.tsx`: `TestPlanCard`,
 * `TestRunsCard`, `DraftTestPlanForm`) — this dashboard stays scoped to
 * defects because that's the one thing worth seeing *across* projects at a
 * glance; a plan or a run only means something in the context of the one
 * project it was written against, which the per-project panel already is.
 *
 * Gated on project.read, same as the per-project QA panel this aggregates —
 * no new capability, and no client ever reaches this (Doc 14: "a client is
 * told what was fixed, not what is currently broken").
 */
export default async function QaDashboardPage() {
  const context = await requireInternal('/qa');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const defects = await listOpenDefects();
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
