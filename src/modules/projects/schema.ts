import { z } from 'zod';

/** Same vocabulary as the projects.projects status CHECK (migration 013). */
export const PROJECT_STATUSES = [
  'planning',
  'onboarding',
  'active',
  'on_hold',
  'completed',
  'cancelled',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Legal project transitions.
 *
 * Mirrors the real workflow: a won deal is planned, then onboarded (kickoff,
 * group, advance payment), then delivery starts. `completed` and `cancelled`
 * are terminal — reopening finished work is a new project, not a status flip.
 */
export const PROJECT_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  planning: ['onboarding', 'cancelled'],
  onboarding: ['active', 'on_hold', 'cancelled'],
  active: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['active', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const setProjectStatusSchema = z.object({
  projectId: z.uuid(),
  status: z.enum(PROJECT_STATUSES),
});

/**
 * Same vocabulary as the projects.milestones status CHECK (migration 006).
 *
 * Written down here rather than invented: these five are already what the
 * database accepts. Nothing in this layer adds a status, and in particular
 * there is no "unlocked" state — a milestone that work may start on is
 * `in_progress`, which is what the column has always meant.
 */
export const MILESTONE_STATUSES = [
  'pending',
  'in_progress',
  'submitted',
  'met',
  'rejected',
] as const;

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/**
 * Statuses that already mean "work may proceed on this milestone".
 *
 * Unlocking one of these is a no-op rather than a move backwards: a milestone
 * a team has already submitted must not be dragged back to in_progress because
 * a payment event was redelivered.
 */
export const UNLOCKED_MILESTONE_STATUSES: readonly MilestoneStatus[] = [
  'in_progress',
  'submitted',
  'met',
];

/**
 * One line of a payment plan.
 *
 * `percent` carries up to two decimals so splits that do not land on whole
 * numbers still add to exactly 100 (e.g. 33.33 / 33.33 / 33.34).
 */
export const paymentPlanItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  percent: z.number().positive().max(100),
  dueOn: z.iso.date().optional(),
});

/**
 * A payment plan is just the project's ordered milestones with their shares.
 *
 * No structure is hard-coded: 30/20/30/20 and 5/10/30/20/35 are equally valid,
 * and so is any other split that totals 100. The only rule is the total, which
 * is enforced twice — here for a useful error message, and by a deferred
 * constraint trigger in the database so it holds regardless of caller.
 */
export const configurePaymentPlanSchema = z
  .object({
    projectId: z.uuid(),
    items: z.array(paymentPlanItemSchema).min(1).max(20),
  })
  .refine(
    (v) => Math.round(v.items.reduce((sum, i) => sum + i.percent, 0) * 100) === 10_000,
    { message: 'Milestone percentages must add up to exactly 100.', path: ['items'] },
  );

export type SetProjectStatusInput = z.infer<typeof setProjectStatusSchema>;
export type PaymentPlanItemInput = z.infer<typeof paymentPlanItemSchema>;
export type ConfigurePaymentPlanInput = z.infer<typeof configurePaymentPlanSchema>;

/**
 * Splits a budget across a plan without losing or inventing money.
 *
 * Each share is floored, then the rounding remainder is added to the final
 * milestone, so the milestone amounts always sum to exactly the budget. Doing
 * this per-row with plain rounding would drift by a few paise, and an invoice
 * total that disagrees with the project budget is a support ticket.
 */
export function splitBudget(
  budgetMinor: number,
  percents: readonly number[],
): number[] {
  const amounts = percents.map((p) => Math.floor((budgetMinor * p) / 100));
  const last = amounts.length - 1;
  if (last >= 0) {
    const assigned = amounts.reduce((sum, a) => sum + a, 0);
    amounts[last] = (amounts[last] ?? 0) + (budgetMinor - assigned);
  }
  return amounts;
}

// ── invoice.paid → next milestone ──────────────────────────────────────────

/**
 * The `invoice.paid` payload finance already emits.
 *
 * Exactly the fields written in finance/service.ts, no more: this parses the
 * existing event rather than defining a second one. `projectId` and
 * `milestoneId` are nullable because finance.invoices allows both — an invoice
 * raised outside a project is a real thing, and it simply has no milestone to
 * unlock.
 *
 * `.loose()` keeps the extra fields finance sends (number, clientAccountId,
 * paidMinor, currency) from failing validation: a handler that breaks when the
 * publisher adds a field is a handler that will break.
 */
export const invoicePaidEventSchema = z.looseObject({
  projectId: z.uuid().nullable(),
  milestoneId: z.uuid().nullable(),
  unlockedMilestoneId: z.uuid().nullable(),
});

export type InvoicePaidEvent = z.infer<typeof invoicePaidEventSchema>;

/** What the handler read out of the database before deciding. */
export type InvoicePaidFacts = {
  /** Organization the job was queued under — from the event row, not its payload. */
  jobOrganizationId: string;
  invoiceId: string | null;
  event: InvoicePaidEvent;
  invoice: {
    id: string;
    organizationId: string;
    projectId: string | null;
    milestoneId: string | null;
    status: string;
    paidMinor: number;
    totalMinor: number;
  } | null;
  target: {
    id: string;
    organizationId: string;
    projectId: string;
    status: string;
  } | null;
  /**
   * The milestone the *live* plan says is next, recomputed from the database
   * at handling time. The event's own `unlockedMilestoneId` is checked against
   * this rather than trusted — see `invoicePaidVerdict`.
   */
  intendedNextMilestoneId: string | null;
};

export type InvoicePaidVerdict =
  /** Move the target milestone pending → in_progress. */
  | { outcome: 'unlock'; milestoneId: string }
  /** Correct and already done. Redelivery lands here. */
  | { outcome: 'already_unlocked'; milestoneId: string; status: string }
  /** Nothing to do, and nothing wrong. The plan is finished, or had no gate. */
  | { outcome: 'nothing_to_unlock'; reason: string }
  /** Refused. `permanent` means retrying will never help. */
  | { outcome: 'refuse'; reason: string; permanent: boolean };

/**
 * Decides what an `invoice.paid` delivery should do — the whole rule, with no
 * database access, so every branch is testable directly.
 *
 * The checks are ordered from the least trusting outward. Delivery is
 * at-least-once and events are replayed, so by the time one is handled the
 * world may have moved: the invoice may have been voided, the plan re-cut, a
 * later milestone already opened by hand. Every claim in the payload is
 * therefore re-verified against what the database says *now*, and the payload
 * is treated as a pointer to facts rather than as the facts.
 *
 * The most important check is the last one. `unlockedMilestoneId` is not
 * obeyed — it is compared against the milestone the current plan says is next.
 * That single comparison is what stops a stale or tampered event from skipping
 * a milestone, and it is why this handler cannot open a stage the client has
 * not actually paid through.
 */
export function invoicePaidVerdict(facts: InvoicePaidFacts): InvoicePaidVerdict {
  const { event, invoice, target } = facts;

  // ── the invoice is real, ours, and paid ─────────────────────────────────
  if (!facts.invoiceId) {
    return { outcome: 'refuse', reason: 'event carries no invoice id', permanent: true };
  }
  if (!invoice) {
    return {
      outcome: 'refuse',
      reason: 'invoice not found in this organization',
      permanent: true,
    };
  }
  if (invoice.organizationId !== facts.jobOrganizationId) {
    return {
      outcome: 'refuse',
      reason: 'invoice belongs to a different organization',
      permanent: true,
    };
  }
  if (invoice.status !== 'paid') {
    return {
      outcome: 'refuse',
      reason: `invoice is ${invoice.status}, not paid`,
      permanent: true,
    };
  }
  // Belt and braces on "actually paid": the status and the money must agree.
  // They can only disagree through a write that bypassed recordManualPayment.
  if (invoice.paidMinor < invoice.totalMinor) {
    return {
      outcome: 'refuse',
      reason: 'invoice is marked paid but its payments do not cover it',
      permanent: true,
    };
  }

  // ── the event describes this invoice ────────────────────────────────────
  if (invoice.projectId !== event.projectId) {
    return {
      outcome: 'refuse',
      reason: 'event names a different project than the invoice',
      permanent: true,
    };
  }
  if (invoice.milestoneId !== event.milestoneId) {
    return {
      outcome: 'refuse',
      reason: 'event names a different milestone than the invoice',
      permanent: true,
    };
  }

  // ── an invoice with no project or milestone has nothing to gate ─────────
  if (!event.projectId || !event.milestoneId) {
    return {
      outcome: 'nothing_to_unlock',
      reason: 'invoice is not attached to a project milestone',
    };
  }

  // ── the plan may already be finished ────────────────────────────────────
  // No next milestone is a normal ending, not a failure, and emphatically not
  // a reason to create one.
  if (!event.unlockedMilestoneId) {
    return {
      outcome: 'nothing_to_unlock',
      reason:
        facts.intendedNextMilestoneId === null
          ? 'no further priced milestone on this plan'
          : 'event unlocked nothing, but the plan has since moved on',
    };
  }

  if (!target) {
    return { outcome: 'refuse', reason: 'target milestone not found', permanent: true };
  }
  if (target.organizationId !== facts.jobOrganizationId) {
    return {
      outcome: 'refuse',
      reason: 'target milestone belongs to a different organization',
      permanent: true,
    };
  }
  if (target.projectId !== event.projectId) {
    return {
      outcome: 'refuse',
      reason: 'target milestone belongs to a different project',
      permanent: true,
    };
  }

  // ── and it is genuinely the next one ────────────────────────────────────
  if (facts.intendedNextMilestoneId !== target.id) {
    return {
      outcome: 'refuse',
      reason:
        facts.intendedNextMilestoneId === null
          ? 'the plan has no milestone waiting to be unlocked'
          : 'the event names a milestone the current plan does not unlock next',
      permanent: true,
    };
  }

  // ── the milestone's own state machine has the final say ─────────────────
  const status = target.status as MilestoneStatus;

  if (UNLOCKED_MILESTONE_STATUSES.includes(status)) {
    return { outcome: 'already_unlocked', milestoneId: target.id, status };
  }
  if (status !== 'pending') {
    return {
      outcome: 'refuse',
      reason: `a ${target.status} milestone is not unlocked by a payment`,
      permanent: true,
    };
  }

  return { outcome: 'unlock', milestoneId: target.id };
}
