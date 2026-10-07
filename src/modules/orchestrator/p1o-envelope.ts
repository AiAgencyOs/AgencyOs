import { z } from 'zod';

/**
 * Phase 1 Orchestrator and Coordination: the task envelope and the routing map (P1-ORCH-003/004/006/009, P1-COORD-003).
 *
 * Pure. `validateTaskEnvelope` is the intake: a malformed or incomplete envelope is refused BEFORE anything runs (Orchestrator s4), with every problem named.
 * `routeTask` is the same decision `ai.p1o_route_task` makes in the database, over the same capability rows, so a caller can ask without a round trip and a test
 * can prove it: a task type resolves to an agent, a service or a person; an unknown or unavailable one has NO safe route and must be escalated, never guessed.
 * Nothing here calls a model.
 */

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

const TASK_TYPE = /^[a-z][a-z_]*\.[a-z_]+$/;

export const taskEnvelopeSchema = z
  .object({
    organizationId: z.uuid(),
    taskType: z.string().regex(TASK_TYPE, 'task type looks like area.action'),
    correlationId: z.uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    fromAgent: z.string().trim().min(1),
    toAgent: z.string().trim().min(1),
    objective: z.string().trim().min(1).max(2000),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1, 'at least one acceptance criterion').max(20),
    priority: z.enum(TASK_PRIORITIES).default('normal'),
    subject: z.object({ type: z.string().trim().min(1), id: z.uuid() }).optional(),
    projectId: z.uuid().optional(),
    dependencyIds: z.array(z.uuid()).max(20).default([]),
    boundProposalId: z.uuid().optional(),
    policyDecisionRef: z.string().trim().min(1).max(200).optional(),
    policyVersion: z.string().trim().min(1).max(100).optional(),
    approvalRequestId: z.uuid().optional(),
    requiredOutputSchema: z.record(z.string(), z.unknown()).optional(),
    context: z.record(z.string(), z.unknown()).default({}),
    slaAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;

export type EnvelopeVerdict = { ok: true; envelope: TaskEnvelope } | { ok: false; problems: string[] };

export function validateTaskEnvelope(input: unknown): EnvelopeVerdict {
  const parsed = taskEnvelopeSchema.safeParse(input);
  if (parsed.success) {
    if (parsed.data.dependencyIds.length !== new Set(parsed.data.dependencyIds).size) return { ok: false, problems: ['dependencyIds: a prerequisite is listed twice'] };
    return { ok: true, envelope: parsed.data };
  }
  return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'envelope'}: ${i.message}`) };
}

/** The arguments of `ai.p1o_create_handoff`, from a validated envelope. */
export function createHandoffArgs(e: TaskEnvelope): Record<string, unknown> {
  return {
    p_organization_id: e.organizationId,
    p_from_agent: e.fromAgent,
    p_to_agent: e.toAgent,
    p_objective: e.objective,
    p_correlation_id: e.correlationId,
    p_idempotency_key: e.idempotencyKey,
    p_acceptance_criteria: e.acceptanceCriteria,
    p_priority: e.priority,
    p_subject_type: e.subject?.type ?? null,
    p_subject_id: e.subject?.id ?? null,
    p_project_id: e.projectId ?? null,
    p_dependency_ids: e.dependencyIds,
    p_bound_proposal_id: e.boundProposalId ?? null,
    p_policy_decision_ref: e.policyDecisionRef ?? null,
    p_policy_version: e.policyVersion ?? null,
    p_approval_request_id: e.approvalRequestId ?? null,
    p_required_output_schema: e.requiredOutputSchema ?? null,
    p_context: e.context,
    p_sla_at: e.slaAt ?? null,
  };
}

export type Capability = {
  taskType: string;
  handlerKind: 'agent' | 'service' | 'human';
  handlerKey: string;
  agentKey: string | null;
  available: boolean;
};

export type Route = { routed: true; handlerKind: Capability['handlerKind']; handlerKey: string } | { routed: false; reason: string };

/** Same decision as `ai.p1o_route_task`. `enabledAgents` is the set of registry agents that are switched on. */
export function routeTask(taskType: string, capabilities: readonly Capability[], enabledAgents: ReadonlySet<string>): Route {
  const cap = capabilities.find((c) => c.taskType === taskType);
  if (!cap) return { routed: false, reason: 'no registered capability for this task type' };
  if (!cap.available || (cap.handlerKind === 'agent' && !(cap.agentKey && enabledAgents.has(cap.agentKey)))) {
    return { routed: false, reason: 'the capable handler is unavailable or disabled' };
  }
  return { routed: true, handlerKind: cap.handlerKind, handlerKey: cap.handlerKey };
}

/** What an escalation for an unroutable task carries: the task, the routes tried, the failures and a recommendation (Orchestrator s19). */
export function noRouteEscalation(taskType: string, route: Extract<Route, { routed: false }>): { cause: 'no_eligible_agent'; recommendation: string; attemptedRoutes: Array<{ taskType: string; reason: string }> } {
  return {
    cause: 'no_eligible_agent',
    recommendation: `No safe route exists for ${taskType} (${route.reason}). A person should handle it or switch the capable agent on.`,
    attemptedRoutes: [{ taskType, reason: route.reason }],
  };
}

/** The Admin Panel A16 board states, in order. The database derives the state; this is the vocabulary the screen filters by. */
export const BOARD_STATES = ['created', 'ready', 'in_progress', 'waiting', 'blocked', 'retrying', 'failed', 'escalated', 'closed'] as const;
export type BoardState = (typeof BOARD_STATES)[number];
export function isBoardState(v: unknown): v is BoardState {
  return typeof v === 'string' && (BOARD_STATES as readonly string[]).includes(v);
}
