import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { agencyClock } from '@/lib/admin/agency-clock';
import { getProject, listDeliverables, listInternalRoster, readScopeBaseline } from '@/modules/projects/queries';
import { listTestPlanVersions, listTestRunDetails, readDefectHistory } from '@/modules/qa/dashboard-queries';
import { listTestCaseResults } from '@/modules/qa/case-results-queries';
import { listDefects, listTestRuns, readTestPlan } from '@/modules/qa/queries';
import { EmptyState, IconCheck, PageHeader, PermissionDenied } from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { DraftTestPlanForm, TestPlanCard, TestRunsCard } from '../test-plan-panel';
import { QaInsights } from './qa-insights';

export const metadata: Metadata = { title: 'Test plan' };

/**
 * SCR-045 — what this project is to be tested for. Needs a frozen scope
 * baseline to point at (Doc 14 §3); if none is active yet, this page sends
 * the reader to the Scope tab rather than rendering a dead end.
 */
export default async function TestPlanPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/qa`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [{ active }, plan, deliverables, runs, runDetails, planVersions, defects, roster, clock, caseResults] = await Promise.all([
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
  ]);
  // SCR-047 — the fix / retest trail, one read for every defect on the project.
  const history = await readDefectHistory(defects.map((d) => d.id));
  const canWrite = can(context.role, 'project.write');
  const canRecordRuns = can(context.role, 'task.write');
  // SCR-045 — approving the plan is the QA sign-off's own role (owner, ops admin).
  const canApprove = can(context.role, 'project.sign_off');
  const builds = deliverables.filter((d) => d.kind === 'build').map((d) => ({ id: d.id, title: d.title, version: d.version }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Test plan`} description="What this project is to be tested for, against its frozen scope baseline." />

      <ProjectSubNav projectId={projectId} />

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
        <TestPlanCard projectId={projectId} plan={plan} scopeItems={active.items} editable={canWrite} canApprove={canApprove} />
      ) : (
        <>
          <EmptyState icon={<IconCheck size={22} />} title="No test plan yet" description={`Baseline v${active.version} is frozen and ready to plan against.`} />
          {canWrite ? <DraftTestPlanForm projectId={projectId} scopeVersionId={active.id} /> : null}
        </>
      )}

      <TestRunsCard projectId={projectId} runs={runs} builds={builds} editable={canRecordRuns} planItems={plan?.items ?? []} results={caseResults} />

      <QaInsights
        projectId={projectId}
        clock={clock}
        runs={runDetails}
        planItems={plan?.items ?? []}
        planVersions={planVersions}
        defects={defects}
        history={history}
        roster={roster.map((m) => ({ userId: m.userId, fullName: m.fullName }))}
        builds={deliverables.map((d) => ({ id: d.id, kind: d.kind, version: d.version, title: d.title }))}
        mayWrite={canWrite}
      />
    </div>
  );
}
