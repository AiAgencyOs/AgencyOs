import { z } from 'zod';

/**
 * The approval vocabulary, and the parts of it that are pure.
 *
 * Gap G-040, decision ADM-08. Everything here mirrors a CHECK constraint in
 * `20260812120011_approval_engine.sql`, and the tests read from this file
 * rather than restating the lists, so the two cannot drift apart quietly —
 * the D22 lesson, applied to vocabulary instead of to tenancy.
 *
 * Nothing in this file talks to a database. The decision of *who may settle
 * what* is made in `approvals.decide_approval`, under a row lock, because two
 * people clicking opposite buttons on the same request is a race and
 * SECURITY.md's rule is that races are settled in Postgres. `canSettle` below
 * is the same rule in TypeScript, for rendering a button — never for
 * authorising a write.
 */

/** Matches the subject_type CHECK on both approvals tables. */
export const APPROVAL_SUBJECT_TYPES = [
  'proposal',
  'deliverable',
  'invoice',
  'refund',
  'scope_change',
  'prototype',
  'agent_action',
  'ticket_plan',
] as const;

export type ApprovalSubjectType = (typeof APPROVAL_SUBJECT_TYPES)[number];

/** Matches the state CHECK on approvals.approval_requests. */
export const APPROVAL_STATES = [
  'pending',
  'approved',
  'rejected',
  'changes_requested',
  'expired',
  'cancelled',
] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];

/**
 * Legal transitions.
 *
 * One step, and it is terminal. A settled request is never re-decided — it is
 * superseded by a new request against the same subject, which the partial
 * unique index permits precisely because it is scoped to `pending`. That is
 * the ordinary path for a rejected deliverable: fix it, raise it again.
 *
 * `expired` is reached by nothing yet. ADM-08c decided that an unanswered
 * request expires and escalates to the owner; the state and `sla_due_at` are
 * here, and the job that walks them is G-096. Recorded rather than implied,
 * because a state nothing can reach reads as a state nobody thought about.
 */
export const APPROVAL_TRANSITIONS: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ['approved', 'rejected', 'changes_requested', 'expired', 'cancelled'],
  approved: [],
  rejected: [],
  changes_requested: [],
  expired: [],
  cancelled: [],
};

/** The decisions a human may take. `expired` is the system's, never a click. */
export const APPROVAL_DECISIONS = ['approved', 'rejected', 'changes_requested', 'cancelled'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Matches the audience CHECK. `client` still renders internally — ADM-08d. */
export const APPROVAL_AUDIENCES = ['internal', 'client'] as const;
export type ApprovalAudience = (typeof APPROVAL_AUDIENCES)[number];

/** Matches the required_role CHECK. Ordered strongest first. */
export const APPROVER_ROLES = ['owner', 'ops_admin', 'delivery_lead'] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

/**
 * Whether a role satisfies a required role.
 *
 * The same rule `decide_approval` enforces, and the reason it is duplicated is
 * worth stating: this one decides whether to *draw* an Approve button, and the
 * one in Postgres decides whether a decision is *recorded*. If they ever
 * disagree the database wins and the user sees a refusal, which is the correct
 * failure — the opposite arrangement is D16, where the wider rule was the one
 * that ran.
 */
export function canSettle(role: string | null | undefined, required: ApproverRole): boolean {
  if (role === 'owner') return true;
  if (required === 'ops_admin') return role === 'ops_admin';
  if (required === 'delivery_lead') return role === 'ops_admin' || role === 'delivery_lead';
  return false;
}

/** A settled request is settled. Kept for readers rather than for writers. */
export function isSettled(state: ApprovalState): boolean {
  return state !== 'pending';
}

/**
 * Whether a request has passed its SLA.
 *
 * Nothing acts on this yet (G-096); the approval queue uses it to sort and to
 * mark a row overdue, which is the visibility half of ADM-08c and the half
 * that needs no job.
 */
export function isOverdue(request: { state: ApprovalState; slaDueAt: string }, now = new Date()): boolean {
  return request.state === 'pending' && new Date(request.slaDueAt).getTime() <= now.getTime();
}

const uuid = z.string().uuid();

export const requestApprovalSchema = z.object({
  subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
  subjectId: uuid,
  summary: z.string().trim().min(1).max(500).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  /**
   * Minor units, like every other amount in this system. Optional because
   * most subjects have no amount; when absent, resolution reads it as zero and
   * lands on the base policy rather than refusing.
   */
  amountMinor: z.number().int().nonnegative().optional(),
  audience: z.enum(APPROVAL_AUDIENCES).optional(),
  correlationId: uuid.optional(),
});

export type RequestApprovalInput = z.infer<typeof requestApprovalSchema>;

export const decideApprovalSchema = z
  .object({
    requestId: uuid,
    decision: z.enum(APPROVAL_DECISIONS),
    note: z.string().trim().max(2000).optional(),
    /**
     * ADM-08d. Where the client's agreement can be read — a WhatsApp message
     * id, a mail reference. Required by the database for a client-audience
     * decision; validated here too so the caller is told which field is
     * missing rather than being handed a constraint violation.
     */
    evidenceRef: z.string().trim().min(1).max(500).optional(),
    clientContactId: uuid.optional(),
  })
  .strict();

export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

export const upsertPolicySchema = z.object({
  subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
  minAmountMinor: z.number().int().nonnegative().default(0),
  requiredRole: z.enum(APPROVER_ROLES),
  slaHours: z.number().int().positive().max(8760),
  audience: z.enum(APPROVAL_AUDIENCES).default('internal'),
  note: z.string().trim().max(500).optional(),
});

export type UpsertPolicyInput = z.infer<typeof upsertPolicySchema>;

/**
 * The money floor, restated for the caller's benefit.
 *
 * `approval_policies_money_floor` refuses these in DDL — ADM-08b was granted
 * on the promise that owner-editable policy could never weaken the gate money
 * already has. This function exists so a form can say why before submitting,
 * not so the rule has a second home: the constraint is the rule.
 */
export function violatesMoneyFloor(input: {
  subjectType: ApprovalSubjectType;
  requiredRole: ApproverRole;
}): string | null {
  if (input.subjectType === 'refund' && input.requiredRole !== 'owner') {
    return 'A refund is owner-only. Policy may make a gate stricter, never looser.';
  }
  if (input.subjectType === 'invoice' && input.requiredRole === 'delivery_lead') {
    return 'An invoice needs owner or ops_admin. Policy may make a gate stricter, never looser.';
  }
  return null;
}
