import { z } from 'zod';

/**
 * P1-COORD-017 / P1-HANDOFF-012: the Coordination Agent's task machine and the unified result envelope, as TypeScript contracts.
 *
 * Pure. The database is the authority (`ai.p1r_transition_allowed`, `ai.p1r_step_allowed`, `ai.p1r_run_result_envelope`); this file mirrors the vocabulary so a
 * screen can offer only the next step and a reader can refuse an envelope that is not in the agreed shape. `tests/p1r-task-state.test.ts` pins this list to the
 * migration, so the two cannot drift.
 */
export const MAIN_LINE = [
  'created', 'validating', 'ready', 'dispatched', 'acknowledged', 'in_progress', 'waiting_for_result', 'result_received',
  'validating_result', 'accepted', 'handoff_ready', 'handed_off', 'verified', 'closed',
] as const;
export const EXCEPTION_STATES = ['blocked', 'retrying', 'failed', 'expired', 'cancelled', 'escalated'] as const;
export const TASK_STATES = [...MAIN_LINE, ...EXCEPTION_STATES] as const;
export type TaskState = (typeof TASK_STATES)[number];

export function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && (TASK_STATES as readonly string[]).includes(v);
}

/** The states a person or worker may move a task to through the door, and the ones that only a signed-in administrator may. */
export const DOOR_STATES: readonly TaskState[] = ['validating', 'ready', 'dispatched', 'waiting_for_result', 'result_received', 'validating_result', 'handoff_ready', 'handed_off', 'verified', 'closed'];
export const PERSON_ONLY_STATES: readonly TaskState[] = ['verified', 'closed'];

/** The one state a task may be stepped to next on the main line (mirrors `ai.p1r_step_allowed`), or null when the next step is made by the work itself. */
export function nextDoorStep(state: TaskState): TaskState | null {
  const i = (MAIN_LINE as readonly string[]).indexOf(state);
  if (i < 0 || i === MAIN_LINE.length - 1) return null;
  const next = MAIN_LINE[i + 1] as TaskState;
  return DOOR_STATES.includes(next) ? next : null;
}

export const STATE_WORDS: Record<TaskState, string> = {
  created: 'Created', validating: 'Validating the contract', ready: 'Ready', dispatched: 'Dispatched', acknowledged: 'Acknowledged', in_progress: 'In progress',
  waiting_for_result: 'Waiting for a result', result_received: 'Result received', validating_result: 'Validating the result', accepted: 'Accepted',
  handoff_ready: 'Ready to hand off', handed_off: 'Handed off', verified: 'Verified', closed: 'Closed',
  blocked: 'Blocked', retrying: 'Retrying', failed: 'Failed', expired: 'Expired', cancelled: 'Cancelled', escalated: 'Escalated to a person',
};

export const RUN_STATUSES = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'budget_exceeded'] as const;
export const VALIDATION_STATUSES = ['verified', 'failed', 'not_validated', 'pending'] as const;
export const NEXT_ACTIONS = ['wait', 'approve', 'proceed', 'validate', 'retry', 'escalate', 'retry_or_escalate', 'raise_budget_or_escalate', 'none'] as const;

/** The unified result envelope (Handoff §4): one object whichever table the facts live in. */
export const resultEnvelopeSchema = z
  .object({
    runId: z.uuid(),
    handoffId: z.uuid().nullable(),
    agent: z.string().min(1),
    status: z.enum(RUN_STATUSES),
    validationStatus: z.enum(VALIDATION_STATUSES),
    warnings: z.array(z.string()),
    errorClass: z.string().nullable(),
    attempt: z.number().int().min(1),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    usage: z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), cacheReadTokens: z.number().int().min(0), cacheWriteTokens: z.number().int().min(0) }),
    costMinor: z.number().int().min(0),
    nextAction: z.enum(NEXT_ACTIONS),
    dodEvidence: z.array(z.unknown()),
    policyVersion: z.string().nullable(),
    taskState: z.string().nullable(),
  })
  .strict();
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;

/** A database answer that is not the agreed shape is refused, never half-trusted. */
export function parseResultEnvelope(value: unknown): { ok: true; envelope: ResultEnvelope } | { ok: false; problems: string[] } {
  const parsed = resultEnvelopeSchema.safeParse(value);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'envelope'}: ${i.message}`) };
}
