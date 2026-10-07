import type { createAdminClient } from '@/lib/db/admin';
import { AGENT_DEFINITIONS } from '@/modules/agents/registry';
import { validateFallback } from '@/modules/orchestrator/fallback';

import { callDoor } from './door';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * P4-ORCH-026: the agent-level fallback for a disabled specialist (Orchestrator spec section 17 / 20: equivalent capability, same family, permissions preserved,
 * record the failure and the reason, escalate if none).
 *
 * `validateFallback` and `projects.fallback_records` existed with no caller. When a Phase 4 hop finds its specialist disabled, the envelope already opens the
 * `disabled_specialist` escalation and holds the job; this adds the consideration of a fallback agent to that moment, and RECORDS it (task-less, through
 * `projects.p4s_record_agent_fallback`):
 *
 *   - every registered agent is judged against the primary by `validateFallback` (same family, no capability gap, no wider tools, money, client-facing,
 *     verification or handoff authority, the same independent verifier);
 *   - a valid candidate that is itself ENABLED is the accepted fallback; a valid but disabled one is rejected as `fallback_disabled`;
 *   - with none valid, the closest rejection (fewest violations) is recorded so a person reads why no safe fallback exists;
 *   - the work is NOT handed over by this code: the fallback record is the evidence, the escalation stays open, and a person routes. A fallback never widens authority
 *     and never bypasses a human gate, because nothing runs.
 */
export type PlanViolation = { code: string; detail: string };
export type FallbackPlan = { primary: string; fallback: string; violations: PlanViolation[]; accepted: boolean };

/** Pure: the one consideration to record, or null when the registry holds no other agent to consider. */
export function planFallbackConsideration(primaryKey: string, enabledKeys: ReadonlySet<string>): FallbackPlan | null {
  const judged: FallbackPlan[] = [];
  for (const candidate of AGENT_DEFINITIONS) {
    if (candidate.key === primaryKey) continue;
    const verdict = validateFallback(primaryKey, candidate);
    const violations: PlanViolation[] = [...verdict.violations];
    if (verdict.valid && !enabledKeys.has(candidate.key)) violations.push({ code: 'fallback_disabled', detail: `${candidate.key} is itself disabled` });
    judged.push({ primary: primaryKey, fallback: candidate.key, violations, accepted: violations.length === 0 });
  }
  if (judged.length === 0) return null;
  const accepted = judged.find((j) => j.accepted);
  if (accepted) return accepted;
  // none is safe: record the closest rejection (fewest violations; a valid-but-disabled candidate has exactly one), in registry order for a stable answer
  return judged.reduce((best, j) => (j.violations.length < best.violations.length ? j : best));
}

export function fallbackReason(plan: FallbackPlan, taskType: string): string {
  if (plan.accepted) return `The specialist ${plan.primary} is disabled for ${taskType}. ${plan.fallback} is eligible (same family, no wider authority): a person routes the work to it.`;
  return `The specialist ${plan.primary} is disabled for ${taskType}. No safe fallback exists; the closest, ${plan.fallback}, was rejected: ${plan.violations.map((v) => v.code).join(', ')}.`;
}

/**
 * Consider and record the fallback for the specialist that owns `taskType`. Best effort by design: the hop is already held and the escalation already open, so a
 * failure here is logged and never changes what the hop does. Returns what it recorded, or why not.
 */
export async function considerFallbackForDisabledSpecialist(admin: Admin, input: { projectId: string; taskType: string }): Promise<{ recorded: boolean; outcome: string }> {
  try {
    const { data: task, error: taskError } = await admin.schema('projects').from('p4q_task_types').select('agent_key').eq('task_type', input.taskType).maybeSingle();
    if (taskError || !task || typeof task.agent_key !== 'string') return { recorded: false, outcome: 'unknown_task_type' };

    const { data: enabled, error: enabledError } = await admin.schema('ai').from('agents').select('key').eq('enabled', true);
    if (enabledError) return { recorded: false, outcome: 'agents_unreadable' };

    const plan = planFallbackConsideration(task.agent_key, new Set((enabled ?? []).map((a) => String(a.key))));
    if (!plan) return { recorded: false, outcome: 'no_candidate' };

    const door = await callDoor(admin, 'projects', 'p4s_record_agent_fallback', {
      p_project_id: input.projectId,
      p_primary_agent: plan.primary,
      p_fallback_agent: plan.fallback,
      p_reason: fallbackReason(plan, input.taskType),
      p_violations: plan.violations,
      p_failure_class: 'disabled_specialist',
    });
    if (!door.ok) return { recorded: false, outcome: 'door_unreachable' };
    const outcome = door.row.outcome ?? 'no answer';
    return { recorded: outcome === 'accepted' || outcome === 'rejected', outcome };
  } catch (cause) {
    console.error(JSON.stringify({ level: 'error', scope: 'p4q.fallback', detail: cause instanceof Error ? cause.message : 'unknown' }));
    return { recorded: false, outcome: 'failed' };
  }
}
