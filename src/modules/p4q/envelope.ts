import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult } from '@/modules/projects/handlers';

import { callDoor } from './door';
import { considerFallbackForDisabledSpecialist } from './fallback-consideration';

type Admin = ReturnType<typeof createAdminClient>;

export type FailureClass = 'transient' | 'permanent' | 'policy_denied' | 'validation' | 'uncertain_side_effect' | 'no_capable_agent' | 'provider_unavailable';

/** Pure: how a failed handler result is classed for the bounded-retry policy. A permanent flag is permanent; a refusal by a door is a policy refusal; the rest are transient. */
export function failureClassFor(result: Extract<HandlerResult, { status: 'failed' }>): FailureClass {
  const d = result.detail.toLowerCase();
  if (d.includes('environment_missing')) return 'provider_unavailable';
  if (d.includes('no capable') || d.includes('no enabled agent')) return 'no_capable_agent';
  if (d.includes('may have') || d.includes('uncertain')) return 'uncertain_side_effect';
  if (d.includes('refused') || d.includes('forbidden') || d.includes('not_authorized')) return 'policy_denied';
  // a model's answer that failed its schema is retried like any transient failure (the next answer can differ); only a bad INPUT is a validation failure
  if (d.includes('model output')) return 'transient';
  if (d.includes('malformed') || d.includes('invalid')) return 'validation';
  return result.permanent ? 'permanent' : 'transient';
}

export type EnvelopeInput = {
  projectId: string;
  taskType: string;
  /** Exact ids only (uiVersionId, artifactId, deliverableId, phaseFourId, decisionId, milestoneId). */
  exactRefs: Record<string, string>;
  /** One per event delivery, e.g. `${job.id}`: a redelivered job reopens nothing. */
  idempotencyKey: string;
  retryBudget?: number;
};

/**
 * Runs one Phase 4 hop inside a persisted ExecutionEnvelope (P4-ORCH-019/025/026/035). The envelope records the exact references, the retry budget and the policy
 * version; a failure is CLASSED and counted; when the budget is spent, the failure is permanent, no agent is capable or the specialist is disabled, a project-scoped
 * escalation is opened for a person and the job is parked. A success closes the envelope. The work itself, and every authority check inside it, is unchanged.
 */
export async function runWithEnvelope(
  admin: Admin,
  input: EnvelopeInput,
  work: () => Promise<HandlerResult>,
  options: { onUnopenable?: 'fail' | 'run_unwrapped' } = {},
): Promise<HandlerResult> {
  const opened = await callDoor(admin, 'projects', 'p4q_open_envelope', {
    p_project_id: input.projectId,
    p_task_type: input.taskType,
    p_exact_refs: input.exactRefs,
    p_idempotency_key: input.idempotencyKey,
    p_retry_budget: input.retryBudget ?? 3,
  });
  if (!opened.ok) {
    if (options.onUnopenable === 'run_unwrapped') {
      console.error(JSON.stringify({ level: 'error', scope: 'p4q.envelope', taskType: input.taskType, detail: `the envelope door did not answer (${opened.message}); the hop runs without one` }));
      return work();
    }
    return { status: 'failed', permanent: false, detail: `the envelope door did not answer: ${opened.message}` };
  }
  const outcome = opened.row.outcome ?? 'no answer';
  const envelopeId = typeof opened.row.envelope_id === 'string' ? opened.row.envelope_id : null;
  if (outcome === 'agent_disabled') {
    // P4-ORCH-026: the agent-level fallback is considered and RECORDED (never run): a person routes the work. Best effort; it cannot change what the hop does.
    await considerFallbackForDisabledSpecialist(admin, { projectId: input.projectId, taskType: input.taskType });
    // The work never runs for a disabled specialist. A live dispatcher (`run_unwrapped`) SETTLES the job as held, as every hop did before envelopes (a disabled
    // agent is the installed default, not a failure: no job dies for it); the escalation the door opened stays on the record. Called without that option it is a
    // permanent failure.
    if (options.onUnopenable === 'run_unwrapped') return { status: 'succeeded', outcome: 'held_specialist_disabled', detail: 'the specialist for this task is disabled: nothing was run, and an escalation was opened for a person' };
    return { status: 'failed', permanent: true, detail: 'the specialist for this task is disabled; an escalation was opened for a person' };
  }
  if (outcome !== 'opened' && outcome !== 'already_open') {
    // `run_unwrapped` is for a live dispatcher whose references come from an event rather than from a person: if the door cannot take them (a stale or
    // unknown reference) the hop still runs exactly as it did before envelopes existed, and the refusal is logged. `agent_disabled` is never bypassed.
    if (options.onUnopenable === 'run_unwrapped') {
      console.error(JSON.stringify({ level: 'error', scope: 'p4q.envelope', taskType: input.taskType, detail: `the envelope was refused (${outcome}); the hop runs without one` }));
      return work();
    }
    return { status: 'failed', permanent: true, detail: `the envelope was refused: ${outcome}` };
  }
  if (!envelopeId) return { status: 'failed', permanent: true, detail: 'the envelope door returned no envelope' };

  const result = await work();
  if (result.status === 'succeeded') {
    await callDoor(admin, 'projects', 'p4q_complete_envelope', { p_envelope_id: envelopeId });
    return result;
  }
  const recorded = await callDoor(admin, 'projects', 'p4q_record_failure', { p_envelope_id: envelopeId, p_failure_class: failureClassFor(result), p_detail: result.detail });
  if (recorded.ok && recorded.row.outcome === 'escalated') {
    return { status: 'failed', permanent: true, detail: `${result.detail} (escalated to a person after ${String(recorded.row.attempts)} attempt(s))` };
  }
  if (recorded.ok && recorded.row.outcome === 'reconcile_first') {
    return { status: 'failed', permanent: true, detail: `${result.detail} (the side effect is uncertain; reconcile it before running again)` };
  }
  return result;
}
