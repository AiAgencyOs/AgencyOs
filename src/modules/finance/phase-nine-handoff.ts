import { z } from 'zod';

import { FINANCE_AGENTS, PROPOSAL_KINDS, type FinanceProposal } from './phase-nine-proposals';

/**
 * The ONE structured handoff payload of a finance proposal (Phase 9 plan section 9): organization, client, project, task, version, milestone, invoice,
 * expected amount, state, references, policy, approvals, evidence, priority, blockers, correlation and retry.
 *
 * The database twin binds (`finance.phase9b_handoff_shape_ok`, the `finance_proposals_handoff_shape` CHECK and the checks inside
 * `finance.record_finance_proposal`): this schema is what a workflow builds BEFORE it calls the door, and the door re-reads the rows and refuses a payload
 * that disagrees with them. A handoff is a claim about a proposal; it carries no authority. It states `moneyAuthority: 'none'` and that an independent
 * review is required, and a payload that says anything else is refused by the shape. The expected amount is the database's own balance of the named
 * invoice, never a figure the model brought.
 *
 * Pure: no I/O, so the workflow, the tests and the panel share one definition.
 */

export const HANDOFF_SCHEMA_VERSION = 1 as const;
export const HANDOFF_PRIORITIES = ['low', 'normal', 'high'] as const;
export type HandoffPriority = (typeof HANDOFF_PRIORITIES)[number];
export const HANDOFF_POLICY_REF = 'phase9.finance-agent' as const;

const id = z.string().uuid();

export const financeHandoffSchema = z
  .object({
    schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
    organizationId: id,
    clientAccountId: id.nullable(),
    projectId: id,
    /** The request is the task: who asked which agent to look at what. */
    requestId: id,
    agentKey: z.enum(FINANCE_AGENTS),
    kind: z.enum(PROPOSAL_KINDS),
    milestoneId: id.nullable(),
    invoiceId: id.nullable(),
    /** The database's outstanding balance of `invoiceId` in minor units; null when no invoice is named. */
    expectedAmountMinor: z.number().int().nonnegative().nullable(),
    currency: z.string().length(3),
    /** The state the project's financial close was in when the run read it (the database's word, not the model's). */
    financialState: z.string().min(1).max(40).nullable(),
    evidenceRefs: z.array(z.string().min(1).max(80)).max(20),
    policy: z.object({ ref: z.literal(HANDOFF_POLICY_REF), moneyAuthority: z.literal('none') }).strict(),
    approvals: z.object({ requestedBy: id, independentReviewRequired: z.literal(true) }).strict(),
    priority: z.enum(HANDOFF_PRIORITIES),
    blockers: z.array(z.object({ code: z.string().min(1).max(80), ref: z.string().max(80).nullable() }).strict()).max(50),
    correlationId: z.string().max(120).nullable(),
    retry: z.object({ attempt: z.number().int().nonnegative(), maxAttempts: z.number().int().positive() }).strict(),
  })
  .strict();
export type FinanceHandoff = z.infer<typeof financeHandoffSchema>;

export type HandoffInput = {
  organizationId: string;
  clientAccountId: string | null;
  projectId: string;
  requestId: string;
  requestedBy: string;
  proposal: Pick<FinanceProposal, 'kind' | 'evidenceRefs'>;
  agent: (typeof FINANCE_AGENTS)[number];
  /** The request's invoice (a reminder draft is about exactly one), with the database's balance. */
  invoice: { id: string; outstandingMinor: number } | null;
  currency: string;
  financialState: string | null;
  blockers: { code: string; ref: string | null }[];
  correlationId: string | null;
  attempt: number;
  maxAttempts: number;
};

/** How soon a person should look: a flag or a classification is a thing that looks wrong; a blocked close is urgent; the rest is routine. */
export function handoffPriority(kind: FinanceProposal['kind'], financialState: string | null): HandoffPriority {
  if (kind === 'anomaly_flag' || kind === 'exception_classification') return 'high';
  if (kind === 'close_readiness_note' && financialState === 'blocked') return 'high';
  return 'normal';
}

export type HandoffBuild = { ok: true; handoff: FinanceHandoff } | { ok: false; reason: string };

/** Build and validate the payload; a build that does not satisfy the schema is a refusal the workflow turns into a failed job, never a repaired payload. */
export function buildFinanceHandoff(input: HandoffInput): HandoffBuild {
  // the one milestone the proposal cites, when it cites exactly one
  const milestones = input.proposal.evidenceRefs.filter((r) => r.startsWith('milestone:'));
  const candidate = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    organizationId: input.organizationId,
    clientAccountId: input.clientAccountId,
    projectId: input.projectId,
    requestId: input.requestId,
    agentKey: input.agent,
    kind: input.proposal.kind,
    milestoneId: milestones.length === 1 ? (milestones[0] as string).slice('milestone:'.length) : null,
    invoiceId: input.invoice?.id ?? null,
    expectedAmountMinor: input.invoice ? input.invoice.outstandingMinor : null,
    currency: input.currency,
    financialState: input.financialState,
    evidenceRefs: [...input.proposal.evidenceRefs],
    policy: { ref: HANDOFF_POLICY_REF, moneyAuthority: 'none' as const },
    approvals: { requestedBy: input.requestedBy, independentReviewRequired: true as const },
    priority: handoffPriority(input.proposal.kind, input.financialState),
    blockers: input.blockers.slice(0, 50).map((b) => ({ code: b.code, ref: b.ref })),
    correlationId: input.correlationId,
    retry: { attempt: Math.max(0, Math.trunc(input.attempt)), maxAttempts: Math.max(1, Math.trunc(input.maxAttempts)) },
  };
  const parsed = financeHandoffSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: `the handoff payload is not valid: ${parsed.error.issues[0]?.path.join('.') || 'payload'}: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  return { ok: true, handoff: parsed.data };
}
