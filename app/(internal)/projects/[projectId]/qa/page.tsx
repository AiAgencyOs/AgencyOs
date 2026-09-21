import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDeliverables, readScopeBaseline } from '@/modules/projects/queries';
import { listTestRuns, readTestPlan } from '@/modules/qa/queries';
import { EmptyState, IconCheck, PageHeader } from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { DraftTestPlanForm, TestPlanCard, TestRunsCard } from '../test-plan-panel';

export const metadata: Metadata = { title: 'Test plan' };

/**
 * SCR-045 — what this project is to be tested for. Needs a frozen scope
 * baseline to point at (Doc 14 §3); if none is active yet, this page sends
 * the reader to the Scope tab rather than rendering a dead end.
 */
export default async function TestPlanPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/qa`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const [{ active }, plan, deliverables, runs] = await Promise.all([
    readScopeBaseline(projectId),
    readTestPlan(projectId),
    listDeliverables(projectId),
    listTestRuns(projectId),
  ]);
  const canWrite = can(context.role, 'project.write');
  const canRecordRuns = can(context.role, 'task.write');
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
        <TestPlanCard projectId={projectId} plan={plan} scopeItems={active.items} editable={canWrite} />
      ) : (
        <>
          <EmptyState icon={<IconCheck size={22} />} title="No test plan yet" description={`Baseline v${active.version} is frozen and ready to plan against.`} />
          {canWrite ? <DraftTestPlanForm projectId={projectId} scopeVersionId={active.id} /> : null}
        </>
      )}

      <TestRunsCard projectId={projectId} runs={runs} builds={builds} editable={canRecordRuns} />
    </div>
  );
}
