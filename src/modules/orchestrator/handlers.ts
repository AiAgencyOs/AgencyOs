import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult, UnlockJob } from '@/modules/projects/handlers';

import { decideDesignerActivation } from './designer-activation';
import { buildExecutionEnvelope, decideDevelopmentRoute, routingPolicyVersion, validateExecutionEnvelope } from './development-route';
import { decideAgentForTask } from './route';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * `project.phase_four_started` → route Task 2's first hop — ORCH §4, §19.
 *
 * The Orchestrator's whole contract in one line (registry.ts's own words):
 * *"Routes work to the responsible agent... Decides nothing about whether
 * work is complete."* This handler is the first real exercise of that
 * contract: Task 2 starts with UI design (Master's locked objective), so the
 * first hop is always the project's own PM agent handing to whichever of its
 * declared targets can do multimodal design work — which
 * `decideAgentForTask` resolves from the registry rather than this handler
 * hardcoding `'ui_designer'` by name.
 *
 * **The routed hop is `ai.handoffs`, not a new table.** That table already
 * has a real schema, a real RLS policy, a real trigger enforcing ADM-83's
 * "receiver must be a declared target" rule, and a real generic reader
 * (`listHandoffs`, the Admin Automations page) — its own comment there names
 * *"the orchestrator at runtime"* as an anticipated writer. Recording the
 * routing decision as a new `routing_decisions` table would be the duplicate
 * system Phase 4's own instructions forbid building when an equivalent
 * already exists.
 *
 * **The phase_four row is re-read, not trusted from the event.** Same rule
 * every handler in this module family follows: an event is a claim about the
 * past, the row is the present, and the actor columns (`pm_agent_key`,
 * `designer_agent_key`) this handler routes against must be the CURRENT ones,
 * not whatever they were when the event was enqueued.
 *
 * **Idempotent by construction, not by a dedupe key alone.** A redelivered
 * event must not create a second handoff for the same Task 2 workspace: this
 * checks for an existing `(project_id, subject_type, subject_id)` handoff
 * before inserting one, the same shape `handlePossibleScopeChangeDetected`
 * uses for its own duplicate-open check.
 *
 * **What this does not do.** It does not invoke the UI Designer, generate a
 * UIVersion, or advance `phase_four.state`. Those belong to the UI Designer
 * Agent stage (gap analysis step 3), which does not exist yet — creating a
 * QUEUED handoff is the complete, honest description of what routing alone
 * can claim to have done.
 */
export async function handleRouteTask2Design(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const phaseFourId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;

  if (!phaseFourId) {
    return { status: 'failed', permanent: true, detail: 'the event named no Phase 4 workspace' };
  }

  const { data: phaseFour, error: phaseFourError } = await admin
    .schema('projects')
    .from('phase_four')
    .select('id, organization_id, project_id, phase_three_handoff_id, pm_agent_key, designer_agent_key, state')
    .eq('id', phaseFourId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (phaseFourError) {
    return { status: 'failed', permanent: false, detail: `the workspace could not be read: ${phaseFourError.message}` };
  }
  if (!phaseFour) {
    return { status: 'failed', permanent: true, detail: 'the Phase 4 workspace no longer exists' };
  }

  const { data: existing, error: existingError } = await admin
    .schema('ai')
    .from('handoffs')
    .select('id, to_agent')
    .eq('organization_id', phaseFour.organization_id)
    .eq('subject_type', 'phase_four')
    .eq('subject_id', phaseFour.id)
    .limit(1)
    .maybeSingle();
  if (existingError) {
    return { status: 'failed', permanent: false, detail: existingError.message };
  }
  if (existing) {
    // Master §22: a duplicate event returns the existing artifact
    // idempotently. The world already has the routing decision this event
    // asked for.
    return {
      status: 'succeeded',
      outcome: 'already_routed',
      detail: `Task 2 was already routed to ${existing.to_agent}.`,
      milestoneId: existing.id,
    };
  }

  // UI Designer §activation: the Designer wakes for a NAMED reason. This hop's reason is condition A (Phase 4 starts on a valid Phase 3
  // baseline - `start_phase_four` already refused anything else); it is recorded on the handoff so the Admin can see why the Designer ran.
  const activation = decideDesignerActivation('initial_phase_four');
  if (!activation.activate) {
    return { status: 'failed', permanent: true, detail: `the Designer was not activated: ${activation.refusedBecause}` };
  }

  const decision = decideAgentForTask({
    fromAgent: phaseFour.pm_agent_key,
    requiredCapabilities: ['multimodal', 'long_context'],
  });

  if (decision.outcome !== 'selected') {
    // Permanent: retrying cannot make a capable candidate exist, and a job
    // that keeps trying hides a registry gap behind an attempt counter — the
    // same argument `handlePhaseThreeReady` makes for its own permanent
    // refusals.
    return {
      status: 'failed',
      permanent: true,
      detail: `no route for Task 2 design work: ${decision.reason}`,
    };
  }

  const { data: handoff, error: handoffError } = await admin
    .schema('ai')
    .from('handoffs')
    .insert({
      organization_id: phaseFour.organization_id,
      // One correlation id per Task 2 workspace, so every hop this workflow
      // ever routes (design, then prototype, per the gap analysis's later
      // steps) is traceable as one chain from the workspace's own id.
      correlation_id: phaseFour.id,
      from_agent: decision.fromAgent,
      to_agent: decision.toAgent,
      project_id: phaseFour.project_id,
      subject_type: 'phase_four',
      subject_id: phaseFour.id,
      objective: 'Task 2: design the complete UI from the locked Phase 3 baseline.',
      context: { phaseThreeHandoffId: phaseFour.phase_three_handoff_id, activationReason: activation.reason, routingReason: decision.reason, candidates: [...decision.candidates] },
    })
    .select('id')
    .single();

  if (handoffError) {
    // The DB trigger (`ai.enforce_handoff_target`) is the second, independent
    // enforcement of the same rule `decideAgentForTask` just checked — a
    // registry/mirror drift `check-record` §16 already guards against, but
    // this handler does not assume the guard above is the only one that
    // matters. A rejection here is therefore a registry/mirror disagreement,
    // not a transient fault, so it is not worth retrying blindly.
    return {
      status: 'failed',
      permanent: false,
      detail: `the handoff could not be recorded: ${handoffError.message}`,
    };
  }

  return {
    status: 'succeeded',
    outcome: 'routed',
    detail: `Task 2 routed: ${decision.fromAgent} → ${decision.toAgent} (${decision.reason}).`,
    milestoneId: handoff.id,
  };
}

/**
 * `project.ui_version_qa_reviewed` → raise Admin review — Impl §7.2; Master's
 * locked objective: "QA PASS → ADMIN REVIEW".
 *
 * Lives beside the routing handler rather than in `qa/handlers.ts`, because
 * raising the NEXT stage's request is a coordination act (ORCH's own
 * definition: "coordinates handoffs"), not a QA judgment — QA already
 * finished its part when it emitted this event.
 *
 * **The event fires for both `qa_pass` and `qa_changes_required`; only the
 * row's CURRENT status decides whether review is raised.** A payload saying
 * `outcome: 'qa_pass'` is a claim about the moment the event was written; the
 * row is the present, and `request_ui_version_admin_review`'s own `wrong_state`
 * refusal is the second, independent check of the same fact.
 */
export async function handleRequestUIVersionAdminReview(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const uiVersionId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;

  if (!uiVersionId) {
    return { status: 'failed', permanent: true, detail: 'the event named no UI version' };
  }

  const { data: version, error: versionError } = await admin
    .schema('projects')
    .from('ui_versions')
    .select('id, status')
    .eq('id', uiVersionId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (versionError) {
    return { status: 'failed', permanent: false, detail: `the version could not be read: ${versionError.message}` };
  }
  if (!version) {
    return { status: 'succeeded', outcome: 'gone', detail: 'the UI version no longer exists' };
  }
  if (version.status !== 'qa_pass') {
    // Design QA asked for changes, or review already started on a replay.
    // Either way there is nothing for this handler to raise.
    return { status: 'succeeded', outcome: 'not_mine', detail: `this version is ${version.status}, not qa_pass` };
  }

  const { data, error } = await admin
    .schema('projects')
    .rpc('request_ui_version_admin_review', { p_ui_version_id: uiVersionId } as never);

  if (error) {
    return { status: 'failed', permanent: false, detail: `the door did not answer: ${error.message}` };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  const outcome = row?.outcome ?? 'no answer';

  switch (outcome) {
    case 'requested':
      return { status: 'succeeded', outcome, detail: 'Admin review requested.' };
    case 'no_policy':
      // Permanent: retrying cannot make an owner configure a review policy
      // that does not exist, and a job that keeps trying hides the missing
      // setup behind an attempt counter.
      return {
        status: 'failed',
        permanent: true,
        detail: 'no approval policy is configured for ui_version reviews — an owner must set one in the Admin Panel.',
      };
    case 'wrong_state':
      return { status: 'succeeded', outcome, detail: 'this version is no longer qa_pass.' };
    case 'unknown_version':
      return { status: 'failed', permanent: true, detail: 'the UI version no longer exists.' };
    default:
      return { status: 'failed', permanent: false, detail: `the door answered ${outcome}` };
  }
}


/**
 * `project.development_plan_approved` -> route each planned task to its specialist - Phase 5 Orchestrator spec.
 *
 * Plan rows are RE-READ, never trusted from the event. A task is routed (an `ai.handoffs` row, orchestrator -> specialist, subject = the task),
 * or HELD with the reason (agent not enabled / NOT_REQUIRED), or refused. Idempotent: a task that already has a handoff is left alone, so a
 * redelivered event routes nothing twice. Nothing here starts a task: `start_task` is its own gate.
 */
export async function handleRouteDevelopmentPlan(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const planId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;
  if (!planId) return { status: 'failed', permanent: true, detail: 'the event named no development plan' };

  const { data: plan, error: planError } = await admin
    .schema('projects')
    .from('development_plans')
    .select('id, project_id, status')
    .eq('id', planId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (planError) return { status: 'failed', permanent: false, detail: `the plan could not be read: ${planError.message}` };
  if (!plan) return { status: 'succeeded', outcome: 'gone', detail: 'the plan no longer exists' };
  if (plan.status !== 'approved') return { status: 'succeeded', outcome: 'not_mine', detail: `the plan is ${plan.status}, not approved` };

  const [{ data: tasks, error: taskError }, { data: agents, error: agentError }, { data: states, error: stateError }, { data: existing, error: existingError }] = await Promise.all([
    admin.schema('projects').from('tasks').select('id, title, required_capability, acceptance_criteria, risk_level, affected_paths').eq('plan_id', plan.id).eq('status', 'todo'),
    admin.schema('ai').from('agents').select('key, enabled'),
    admin.schema('projects').from('phase_five_agent_state').select('agent_key, state').eq('project_id', plan.project_id),
    admin.schema('ai').from('handoffs').select('subject_id').eq('organization_id', job.organization_id).eq('subject_type', 'development_task').eq('project_id', plan.project_id),
  ]);
  if (taskError) return { status: 'failed', permanent: false, detail: `the tasks could not be read: ${taskError.message}` };
  if (agentError) return { status: 'failed', permanent: false, detail: `the agents could not be read: ${agentError.message}` };
  if (stateError) return { status: 'failed', permanent: false, detail: `the specialist states could not be read: ${stateError.message}` };
  if (existingError) return { status: 'failed', permanent: false, detail: `existing handoffs could not be read: ${existingError.message}` };

  const { data: baselineRow, error: baselineError } = await admin
    .schema('projects')
    .from('development_baselines')
    .select('id, scope_version_id, ui_version_id, prototype_deliverable_id, repository_id, base_commit')
    .eq('project_id', plan.project_id)
    .maybeSingle();
  if (baselineError) return { status: 'failed', permanent: false, detail: `the baseline could not be read: ${baselineError.message}` };
  const baselineId = baselineRow?.id ?? null;

  // readiness facts for the routing decision: which upstream tasks are not done, and which tasks have a QA defect to fix
  const taskIds = (tasks ?? []).map((t) => t.id as string);
  const [{ data: depRows, error: depError }, { data: defectRows, error: defectError }] = taskIds.length
    ? await Promise.all([
        admin.schema('projects').from('task_dependencies').select('task_id, depends_on_task_id').in('task_id', taskIds),
        admin.schema('qa').from('defects').select('task_id').in('task_id', taskIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (depError) return { status: 'failed', permanent: false, detail: `the task dependencies could not be read: ${depError.message}` };
  if (defectError) return { status: 'failed', permanent: false, detail: `the linked defects could not be read: ${defectError.message}` };
  const upstreamIds = [...new Set((depRows ?? []).map((d) => d.depends_on_task_id as string))];
  const { data: upstreamRows, error: upstreamError } = upstreamIds.length
    ? await admin.schema('projects').from('tasks').select('id, status').in('id', upstreamIds)
    : { data: [], error: null };
  if (upstreamError) return { status: 'failed', permanent: false, detail: `the upstream tasks could not be read: ${upstreamError.message}` };
  const upstreamStatus = new Map((upstreamRows ?? []).map((t) => [t.id as string, t.status as string]));
  const openDeps = (taskId: string) =>
    (depRows ?? []).filter((d) => d.task_id === taskId && !['done', 'cancelled'].includes(upstreamStatus.get(d.depends_on_task_id as string) ?? '')).length;
  const dependencyIds = (taskId: string) => (depRows ?? []).filter((d) => d.task_id === taskId).map((d) => d.depends_on_task_id as string);
  const defectTaskIds = new Set((defectRows ?? []).map((d) => d.task_id as string));
  const baselineRefs = {
    scopeVersionId: (baselineRow?.scope_version_id as string | null) ?? null,
    uiVersionId: (baselineRow?.ui_version_id as string | null) ?? null,
    prototypeVersionId: (baselineRow?.prototype_deliverable_id as string | null) ?? null,
  };

  const enabled = new Map((agents ?? []).map((a) => [a.key as string, a.enabled === true]));
  const agentState = new Map((states ?? []).map((s) => [s.agent_key as string, s.state as string]));
  const already = new Set((existing ?? []).map((h) => h.subject_id as string));

  let routed = 0;
  let held = 0;
  let refused = 0;
  for (const task of tasks ?? []) {
    if (already.has(task.id)) continue;
    const decision = decideDevelopmentRoute({
      requiredCapability: task.required_capability,
      enabled,
      agentState,
      baselineId,
      openDependencies: openDeps(task.id),
      riskLevel: task.risk_level,
      affectedPaths: task.affected_paths,
      taskText: `${task.title}\n${task.acceptance_criteria ?? ''}`,
      hasLinkedDefect: defectTaskIds.has(task.id),
    });
    // Every decision is stored, whatever it was: "held" and "refused" are exactly the ones an Admin needs to see. (task, outcome, code) is
    // unique, so a redelivered event records nothing twice.
    const { error: decisionError } = await admin
      .schema('projects')
      .from('routing_decisions')
      .upsert(
        {
          organization_id: job.organization_id,
          project_id: plan.project_id,
          plan_id: plan.id,
          task_id: task.id,
          to_agent: 'toAgent' in decision ? decision.toAgent : null,
          outcome: decision.outcome,
          code: 'code' in decision ? decision.code : '',
          reason: decision.reason,
          candidates: decision.candidates,
          policy_version: routingPolicyVersion(),
          baseline_refs: baselineRefs,
          correlation_id: plan.id,
          requires_security_review: decision.requiresSecurityReview,
        },
        { onConflict: 'task_id,outcome,code', ignoreDuplicates: true },
      );
    if (decisionError) return { status: 'failed', permanent: false, detail: `the routing decision for "${task.title}" could not be recorded: ${decisionError.message}` };
    if (decision.outcome === 'held') {
      held += 1;
      continue;
    }
    if (decision.outcome === 'refused') {
      refused += 1;
      // a task nothing can take is not a quiet row: it is escalated to a person with the reason and what was considered
      const { error: escalationError } = await admin
        .schema('projects')
        .from('orchestrator_escalations')
        .upsert(
          {
            organization_id: job.organization_id,
            project_id: plan.project_id,
            task_id: task.id,
            required_capability: task.required_capability,
            root_cause: decision.code,
            candidates: decision.candidates,
            recommendation: `${decision.reason}. Change the task's specialist or its wording in the plan, then route it again.`,
          },
          { onConflict: 'task_id,root_cause', ignoreDuplicates: true },
        );
      if (escalationError && !/duplicate|conflict/i.test(escalationError.message)) {
        return { status: 'failed', permanent: false, detail: `the escalation for "${task.title}" could not be recorded: ${escalationError.message}` };
      }
      continue;
    }
    const builtEnvelope = buildExecutionEnvelope({
      task: { id: task.id, title: task.title, acceptanceCriteria: task.acceptance_criteria ?? '' },
      planId: plan.id,
      organizationId: job.organization_id,
      projectId: plan.project_id,
      baselineId,
      destination: decision.toAgent,
      routingReason: decision.reason,
      riskLevel: task.risk_level,
      affectedPaths: task.affected_paths,
      dependencyTaskIds: dependencyIds(task.id),
      baselineRefs,
      repository: { repositoryId: (baselineRow?.repository_id as string | null) ?? null, baseCommit: (baselineRow?.base_commit as string | null) ?? null },
    });
    // an incomplete or unsafe envelope is rejected, never repaired: the task is held with the reason and nothing is handed off
    const envelopeProblems = validateExecutionEnvelope(builtEnvelope);
    if (envelopeProblems.length > 0) {
      held += 1;
      await admin.schema('projects').from('routing_decisions').upsert(
        {
          organization_id: job.organization_id, project_id: plan.project_id, plan_id: plan.id, task_id: task.id, to_agent: decision.toAgent, outcome: 'held',
          code: 'envelope_invalid', reason: envelopeProblems.join('; '), candidates: decision.candidates, policy_version: routingPolicyVersion(), baseline_refs: baselineRefs, correlation_id: plan.id,
        },
        { onConflict: 'task_id,outcome,code', ignoreDuplicates: true },
      );
      continue;
    }
    // the security specialist reviews the BUILD, not the plan: its review is recorded as a waiting decision, not a handoff before code exists
    if (decision.requiresSecurityReview) {
      await admin.schema('projects').from('routing_decisions').upsert(
        {
          organization_id: job.organization_id, project_id: plan.project_id, plan_id: plan.id, task_id: task.id, to_agent: 'security_review', outcome: 'held',
          code: 'security_review_required', reason: 'this task is high-risk or touches security-sensitive paths: security_review must review the build before QA can pass it',
          candidates: [], policy_version: routingPolicyVersion(), baseline_refs: baselineRefs, correlation_id: plan.id, requires_security_review: true,
        },
        { onConflict: 'task_id,outcome,code', ignoreDuplicates: true },
      );
    }
    const { error: insertError } = await admin
      .schema('ai')
      .from('handoffs')
      .insert({
        organization_id: job.organization_id,
        correlation_id: plan.id,
        from_agent: 'orchestrator',
        to_agent: decision.toAgent,
        project_id: plan.project_id,
        task_id: task.id,
        subject_type: 'development_task',
        subject_id: task.id,
        objective: `Development task: ${task.title}`,
        context: {
          planId: plan.id,
          routingReason: decision.reason,
          envelope: JSON.parse(JSON.stringify(builtEnvelope)),
        },
      });
    if (insertError) return { status: 'failed', permanent: false, detail: `the handoff for "${task.title}" could not be recorded: ${insertError.message}` };
    routed += 1;
  }

  return { status: 'succeeded', outcome: routed > 0 ? 'routed' : held > 0 ? 'held' : 'nothing_to_route', detail: `${routed} routed, ${held} held (specialist not enabled or not required), ${refused} refused.` };
}
