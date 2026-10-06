import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult, UnlockJob } from '@/modules/projects/handlers';

import { routingPolicyVersion } from './development-route';
import { routeQaFailed, routeQaPassed, type QaRoutingDecision } from './event-map';
import { recordRoutingDecision } from './orchestrator-service';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * `project.dev_task_qa_failed` / `project.dev_task_qa_passed` -> route the outcome - Phase 5 Orchestrator spec section 11:
 *
 *   DevelopmentTaskQAFailed   Route defect/fix to original or Bug Fix specialist
 *   DevelopmentTaskQAPassed   Mark eligible for integration/acceptance
 *
 * The event is a CLAIM and the rows are the present (row authority over event payload): the task, its closed test runs and its defects are re-read,
 * and the decision is made against what they say now. An event whose claim the rows no longer bear out (QA failed, then a later run passed) records
 * nothing and says so. The decision itself is `routeQaFailed` / `routeQaPassed` (pure, in event-map.ts); this only gathers the facts and writes the
 * decision through `recordRoutingDecision`, which also escalates a refusal to a person. `(task_id, outcome, code)` is unique, so a redelivered event
 * records nothing twice.
 *
 * What this never does (ADM-82): judge completion, act as QA, override QA or certify delivery. A pass here is "eligible for integration", never
 * "accepted". Nothing is handed to the fixing specialist yet either: that is the decision recorded, for the specialist's own activation to act on.
 */
export async function handleRouteQaOutcome(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const taskId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;
  const eventType = envelope.eventType;
  if (!taskId) return { status: 'failed', permanent: true, detail: 'the event named no task' };
  if (eventType !== 'project.dev_task_qa_failed' && eventType !== 'project.dev_task_qa_passed') {
    return { status: 'failed', permanent: true, detail: `this handler does not route ${String(eventType)}` };
  }

  const { data: task, error: taskError } = await admin
    .schema('projects')
    .from('tasks')
    .select('id, project_id, plan_id, required_capability, risk_level, status')
    .eq('id', taskId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (taskError) return { status: 'failed', permanent: false, detail: `the task could not be read: ${taskError.message}` };
  if (!task) return { status: 'succeeded', outcome: 'gone', detail: 'the task no longer exists' };
  if (!task.plan_id) return { status: 'succeeded', outcome: 'not_mine', detail: 'the task is not part of a development plan' };

  const { data: evidence, error: evidenceError } = await admin.schema('projects').from('task_test_evidence').select('test_run_id').eq('task_id', task.id);
  if (evidenceError) return { status: 'failed', permanent: false, detail: `the task's test evidence could not be read: ${evidenceError.message}` };
  const runIds = (evidence ?? []).map((e) => e.test_run_id as string);
  const { data: runRows, error: runError } = runIds.length
    ? await admin
        .schema('qa')
        .from('test_runs')
        .select('id, deliverable_id, status, passed, failed, blocked, executed_at, executed_by, executed_by_agent, tester_id')
        .in('id', runIds)
        .eq('organization_id', job.organization_id)
        .eq('status', 'closed')
        .order('executed_at', { ascending: false })
    : { data: [], error: null };
  if (runError) return { status: 'failed', permanent: false, detail: `the test runs could not be read: ${runError.message}` };
  const runs = runRows ?? [];
  const { data: defectRows, error: defectError } = await admin.schema('qa').from('defects').select('id, status').eq('task_id', task.id).eq('organization_id', job.organization_id);
  if (defectError) return { status: 'failed', permanent: false, detail: `the task's defects could not be read: ${defectError.message}` };
  const defects = defectRows ?? [];
  const openDefects = defects.filter((d) => d.status === 'open').length;

  const isFailing = (r: (typeof runs)[number]) => (r.failed as number) > 0 || (r.blocked as number) > 0;
  const latest = runs[0] ?? null;
  const failingNow = openDefects > 0 || (latest !== null && isFailing(latest));
  const passingNow = openDefects === 0 && latest !== null && !isFailing(latest) && (latest.passed as number) > 0;

  let decision: QaRoutingDecision;
  if (eventType === 'project.dev_task_qa_failed') {
    if (!failingNow) return { status: 'succeeded', outcome: 'stale', detail: 'QA has passed this task since the failure was announced; nothing to route' };
    const { data: agents, error: agentError } = await admin.schema('ai').from('agents').select('key, enabled');
    if (agentError) return { status: 'failed', permanent: false, detail: `the agents could not be read: ${agentError.message}` };
    decision = routeQaFailed({
      originalSpecialist: task.required_capability,
      failureKind: openDefects > 0 ? 'defect' : 'incomplete',
      // how many times QA has failed this task: its failing runs, or its defects when that is more
      attempt: Math.max(1, runs.filter(isFailing).length, defects.length),
      enabled: new Map((agents ?? []).map((a) => [a.key as string, a.enabled === true])),
    });
  } else {
    if (!passingNow || !latest) return { status: 'succeeded', outcome: 'stale', detail: 'the task does not currently stand passed by QA; nothing to route' };
    const [{ data: qaDetail, error: qaDetailError }, { data: builds, error: buildsError }, { data: security, error: securityError }, { data: depRows, error: depError }] =
      await Promise.all([
        admin.schema('projects').from('deliverable_details').select('commit_ref').eq('deliverable_id', latest.deliverable_id as string).maybeSingle(),
        admin.schema('projects').from('deliverables').select('id').eq('project_id', task.project_id).eq('kind', 'build').order('version', { ascending: false }).limit(1),
        admin.schema('projects').from('routing_decisions').select('id').eq('task_id', task.id).eq('requires_security_review', true).limit(1),
        admin.schema('projects').from('task_dependencies').select('depends_on_task_id').eq('task_id', task.id),
      ]);
    if (qaDetailError) return { status: 'failed', permanent: false, detail: `the QA build could not be read: ${qaDetailError.message}` };
    if (buildsError) return { status: 'failed', permanent: false, detail: `the current build could not be read: ${buildsError.message}` };
    if (securityError) return { status: 'failed', permanent: false, detail: `the security-review state could not be read: ${securityError.message}` };
    if (depError) return { status: 'failed', permanent: false, detail: `the task dependencies could not be read: ${depError.message}` };

    const currentBuildId = (builds ?? [])[0]?.id as string | undefined;
    const { data: currentDetail, error: currentError } = currentBuildId
      ? await admin.schema('projects').from('deliverable_details').select('commit_ref').eq('deliverable_id', currentBuildId).maybeSingle()
      : { data: null, error: null };
    if (currentError) return { status: 'failed', permanent: false, detail: `the current build's commit could not be read: ${currentError.message}` };

    const upstreamIds = (depRows ?? []).map((d) => d.depends_on_task_id as string);
    const { data: upstream, error: upstreamError } = upstreamIds.length ? await admin.schema('projects').from('tasks').select('id, status').in('id', upstreamIds) : { data: [], error: null };
    if (upstreamError) return { status: 'failed', permanent: false, detail: `the upstream tasks could not be read: ${upstreamError.message}` };

    // who verified: an agent, or a person; a run that names neither stays unattributed and so is not an independent pass
    const person = (latest.executed_by ?? latest.tester_id) as string | null;
    const verifiedBy = (latest.executed_by_agent as string | null) ?? (person ? `user:${person}` : 'unattributed');
    decision = routeQaPassed({
      producedBy: task.required_capability ?? 'unknown',
      verifiedBy,
      qaCommit: (qaDetail?.commit_ref as string | null | undefined) ?? null,
      currentCommit: (currentDetail?.commit_ref as string | null | undefined) ?? null,
      securityReviewRequired: task.risk_level === 'high' || task.risk_level === 'critical' || (security ?? []).length > 0,
      // no record of a finished security review exists yet, so none is claimed
      securityReviewDone: false,
      openDependencies: (upstream ?? []).filter((t) => !['done', 'cancelled'].includes(t.status as string)).length,
    });
  }

  const recorded = await recordRoutingDecision(admin, decision, {
    organizationId: job.organization_id,
    projectId: task.project_id,
    planId: task.plan_id,
    taskId: task.id,
    policyVersion: routingPolicyVersion(),
  });
  if (!recorded.ok) return { status: 'failed', permanent: false, detail: recorded.detail };
  return { status: 'succeeded', outcome: decision.outcome, detail: `${decision.code}: ${decision.reason}` };
}
