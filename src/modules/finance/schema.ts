import { z } from 'zod';

/**
 * Finance validation and money arithmetic.
 *
 * Everything here is pure and dependency-free apart from Zod, which is what
 * makes the parts that decide amounts unit-testable without a database. No
 * function in this file talks to a payment provider, and none exists that
 * could: recording money is a human act until a gateway is integrated.
 */

/** Same vocabulary as the finance.invoices status CHECK (migration 007). */
export const INVOICE_STATUSES = [
  'draft',
  'pending_approval',
  'issued',
  'partially_paid',
  'paid',
  'void',
  'overdue',
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Legal invoice transitions.
 *
 * The shape mirrors the business flow: a draft is prepared internally, issuing
 * it is what sends it to the client (RLS reveals non-draft invoices to the
 * client portal, so issuing *is* sharing), and payment moves it the rest of
 * the way. `paid` is terminal — money that came back is a refund, not a status
 * flip. `void` is terminal too and is the only way to withdraw a wrong bill.
 *
 * `partially_paid` and `paid` are never set by a human choosing them: they are
 * derived from recorded payments (see `applyPayment`), because an invoice's
 * paid state must agree with the payments that back it.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['pending_approval', 'issued', 'void'],
  pending_approval: ['draft', 'issued', 'void'],
  issued: ['partially_paid', 'paid', 'overdue', 'void'],
  partially_paid: ['paid', 'overdue', 'void'],
  overdue: ['partially_paid', 'paid', 'void'],
  paid: [],
  void: [],
};

/** Statuses a client may see. Matches the invoices_select policy exactly. */
export const CLIENT_VISIBLE_INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'issued',
  'partially_paid',
  'paid',
  'void',
  'overdue',
];

/** An invoice can still be paid against while in one of these. */
export const PAYABLE_INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'issued',
  'partially_paid',
  'overdue',
];

/**
 * How a manually received payment reached us.
 *
 * Deliberately not a provider list: none of these is an integration, they are
 * descriptions of what the human is asserting happened. A gateway, when it
 * arrives, writes `provider = 'razorpay'` rows from its webhook and never
 * passes through this enum.
 */
export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'cheque', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// The provider value for a human-recorded receipt used to live here as an
// exported constant. Its only consumer was the audit payload assembled in
// service.ts; the row itself has always been written by
// finance.record_manual_payment with a literal, and payments_manual_insert
// checks the same literal. Once the audit moved into that function (G-079)
// nothing in TypeScript wrote the value, and a constant nothing writes reads
// as though TypeScript decides the provider. It does not.

/**
 * The idempotency key a manual receipt is stored under.
 *
 * finance.payments is unique on (provider, provider_payment_id), which exists
 * for webhook replay protection and works just as well here: recording the
 * same bank reference against the same invoice twice is refused by the
 * database, so a double-submitted form cannot double-count a payment.
 *
 * Scoped by invoice rather than global, because one bank transfer legitimately
 * settles two invoices — a shared reference across different invoices is
 * bookkeeping, not a duplicate.
 */
export function manualPaymentKey(invoiceId: string, reference: string): string {
  return `${invoiceId}:${reference.trim()}`;
}

/** The human's original reference, recovered from the stored key. */
export function displayPaymentReference(providerPaymentId: string): string {
  const separator = providerPaymentId.indexOf(':');
  return separator === -1 ? providerPaymentId : providerPaymentId.slice(separator + 1);
}

// ── Inputs ─────────────────────────────────────────────────────────────────

export const generateMilestoneInvoiceSchema = z.object({
  milestoneId: z.uuid(),
  /**
   * Payment terms in days, applied only when the milestone has no due date of
   * its own. Absent means the invoice carries no due date rather than an
   * invented one.
   */
  dueInDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const issueInvoiceSchema = z.object({
  invoiceId: z.uuid(),
  /** Overrides the due date carried over from the milestone. */
  dueOn: z.iso.date().optional(),
});

export const voidInvoiceSchema = z.object({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

/**
 * A payment somebody has actually seen land.
 *
 * `reference` is required and is the point of the whole record: a bank UTR,
 * UPI transaction id or cheque number is the evidence that distinguishes
 * "payment received" from "somebody clicked a button". It is also the
 * idempotency key — finance.payments is unique on (provider,
 * provider_payment_id), so submitting the same reference twice is refused by
 * the database rather than double-counted.
 */
export const recordManualPaymentSchema = z.object({
  invoiceId: z.uuid(),
  amountMinor: z.number().int().positive().max(1_000_000_000_000),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().min(1).max(120),
  receivedAt: z.iso.datetime().optional(),
  notes: z.string().trim().max(500).optional(),
});

export type GenerateMilestoneInvoiceInput = z.infer<typeof generateMilestoneInvoiceSchema>;
export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;
export type VoidInvoiceInput = z.infer<typeof voidInvoiceSchema>;
export type RecordManualPaymentInput = z.infer<typeof recordManualPaymentSchema>;

// ── Invoice numbering ──────────────────────────────────────────────────────

const NUMBER_PREFIX = 'INV';
const NUMBER_PAD = 4;

/** `INV-2026-0001`. Per-organization, per-year, zero padded so it sorts. */
export function formatInvoiceNumber(year: number, sequence: number): string {
  return `${NUMBER_PREFIX}-${year}-${String(sequence).padStart(NUMBER_PAD, '0')}`;
}

/** The `like` pattern that selects one year's numbers. */
export function invoiceNumberPrefix(year: number): string {
  return `${NUMBER_PREFIX}-${year}-`;
}

/**
 * Sequence encoded in an invoice number, or 0 when it is not one of ours.
 *
 * Tolerant by design: a number typed in by hand, or imported from whatever the
 * agency used before, must not break numbering for everything after it.
 */
export function parseInvoiceSequence(number: string | null | undefined, year: number): number {
  if (!number) return 0;
  const prefix = invoiceNumberPrefix(year);
  if (!number.startsWith(prefix)) return 0;
  const parsed = Number.parseInt(number.slice(prefix.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The next number to attempt, given the highest one already seen.
 *
 * `attempt` exists because numbering is allocated optimistically: the caller
 * reads the current maximum, tries to insert, and lets `unique (organization_id,
 * number)` referee. A losing writer retries with the next candidate rather
 * than re-reading and racing again, so concurrent generation converges instead
 * of livelocking.
 */
export function nextInvoiceNumber(year: number, highestSequence: number, attempt = 0): string {
  return formatInvoiceNumber(year, highestSequence + 1 + attempt);
}

// ── Money ──────────────────────────────────────────────────────────────────

/** Minor units per major unit. Two everywhere this system currently bills. */
const MINOR_PER_MAJOR = 100;

/**
 * Parses what a human types into exact minor units. Null when it is not money.
 *
 * Done by string surgery rather than `Math.round(Number(x) * 100)` on purpose:
 * that expression is wrong for values people actually type — `Number('8.07') *
 * 100` is 806.9999999999999, and rounding hides the problem until the day it
 * does not. Splitting on the decimal point and padding the fraction is exact
 * for every input, which is the standard this codebase already holds itself to
 * by storing money as integers in the first place.
 *
 * Accepts thousands separators and a leading currency symbol, because those
 * get pasted in from bank statements constantly. Rejects more than two decimal
 * places rather than silently truncating a third: a caller who typed 1.005
 * meant something, and quietly deciding which side to round to is not our
 * decision to make.
 */
export function parseMinorUnits(input: string): number | null {
  const cleaned = input.trim().replace(/[\s,₹$€£]/g, '');
  if (cleaned === '') return null;

  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return null;

  const [, sign, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;
  if (fraction.length > 2) return null;

  const minor =
    Number.parseInt(whole || '0', 10) * MINOR_PER_MAJOR +
    Number.parseInt(fraction.padEnd(2, '0') || '0', 10);

  if (!Number.isSafeInteger(minor)) return null;
  return sign === '-' ? -minor : minor;
}

export type InvoiceLine = {
  position: number;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
  taxRateBp: number;
};

export type InvoiceTotals = {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
};

/**
 * The lines a payment milestone bills as.
 *
 * **The milestone's configured amount is the source of truth.** It is copied
 * across, never recomputed from a percentage here: the split was already
 * resolved into minor units when the plan was saved (projects/schema.ts
 * `splitBudget`), and re-deriving it at invoice time would let a later budget
 * edit silently change what a client was told they owe. The percentage travels
 * along in the description only, as a human-readable reminder of the deal.
 *
 * One milestone produces exactly one line. Splitting a milestone across lines
 * would make the invoice total and the milestone amount two numbers that can
 * disagree, which is precisely the bug this design refuses to have.
 */
export function milestoneInvoiceLines(milestone: {
  name: string;
  amountMinor: number;
  paymentPercent: number | null;
  position: number;
  projectName?: string | null;
}): InvoiceLine[] {
  const share =
    milestone.paymentPercent === null ? '' : ` — ${trimPercent(milestone.paymentPercent)}%`;
  const project = milestone.projectName ? `${milestone.projectName}: ` : '';

  return [
    {
      position: 0,
      description: `${project}${milestone.name} (milestone ${milestone.position + 1})${share}`,
      quantity: 1,
      unitPriceMinor: milestone.amountMinor,
      amountMinor: milestone.amountMinor,
      // No tax engine exists yet, and inventing a default GST rate here would
      // be a policy decision disguised as a constant. The column is present so
      // that decision has somewhere to land.
      taxRateBp: 0,
    },
  ];
}

/** `30.00` reads as `30`; `33.33` stays `33.33`. */
function trimPercent(percent: number): string {
  return String(Number(percent.toFixed(2)));
}

/**
 * Invoice totals from its lines.
 *
 * Integer arithmetic throughout — tax is basis points against a minor-unit
 * amount, floored per line, so no line contributes a fraction of a paisa and
 * the total is exactly the sum of what each line says.
 */
export function invoiceTotals(lines: readonly InvoiceLine[]): InvoiceTotals {
  const subtotalMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const taxMinor = lines.reduce(
    (sum, line) => sum + Math.floor((line.amountMinor * line.taxRateBp) / 10_000),
    0,
  );
  return { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
}

export type PaymentOutcome =
  | { ok: true; paidMinor: number; status: InvoiceStatus; fullyPaid: boolean }
  | { ok: false; reason: 'not_payable' | 'overpayment' | 'non_positive' };

/**
 * What recording a payment does to an invoice.
 *
 * `paidSoFarMinor` is the sum of captured payments, not the invoice's stored
 * `paid_minor`. Deriving the new state from the payments themselves is what
 * makes a retried write land on the same answer instead of double-counting —
 * the DB constraint `paid_minor <= total_minor` is the last line of defence,
 * not the mechanism.
 *
 * Overpayment is refused rather than clamped. Money arriving that nobody
 * expected is a conversation with the client, not a rounding decision.
 */
export function applyPayment(input: {
  status: InvoiceStatus;
  totalMinor: number;
  paidSoFarMinor: number;
  amountMinor: number;
}): PaymentOutcome {
  if (!PAYABLE_INVOICE_STATUSES.includes(input.status)) return { ok: false, reason: 'not_payable' };
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    return { ok: false, reason: 'non_positive' };
  }

  const paidMinor = input.paidSoFarMinor + input.amountMinor;
  if (paidMinor > input.totalMinor) return { ok: false, reason: 'overpayment' };

  const fullyPaid = paidMinor === input.totalMinor;
  return {
    ok: true,
    paidMinor,
    status: fullyPaid ? 'paid' : 'partially_paid',
    fullyPaid,
  };
}

// ── The unlock signal ──────────────────────────────────────────────────────

/**
 * A milestone plus whatever invoice is attached to it, as the billing views
 * and the unlock rule see it.
 */
export type MilestoneBillingEntry = {
  milestoneId: string;
  position: number;
  /** Null for delivery-only checkpoints, which carry no payment. */
  paymentPercent: number | null;
  invoiceStatus: InvoiceStatus | null;
};

/**
 * How many priced milestones, counting from the start of the plan, have been
 * paid for.
 *
 * This is the state that PAYMENT RECEIVED → NEXT PROJECT STAGE UNLOCKED reads.
 * It is derived, never stored: a stored "unlocked" flag and the invoices it
 * claims to summarise can disagree, and then the question "is this client paid
 * up?" has two answers.
 *
 * Unpriced milestones are transparent — a delivery checkpoint with no money
 * attached never gates the next payment.
 */
export function paidThrough(entries: readonly MilestoneBillingEntry[]): number {
  const priced = [...entries]
    .filter((e) => e.paymentPercent !== null)
    .sort((a, b) => a.position - b.position);

  let count = 0;
  for (const entry of priced) {
    if (entry.invoiceStatus !== 'paid') break;
    count += 1;
  }
  return count;
}

/**
 * The milestone the client's payment has just unlocked — the first priced
 * milestone that is not yet paid for, provided everything before it is.
 *
 * Returns null when the plan is fully paid, or when an earlier milestone is
 * still outstanding, in which case nothing new is unlocked.
 *
 * Deliberately advisory. Nothing in this codebase refuses to generate an
 * invoice for a later milestone because an earlier one is unpaid — an agency
 * routinely bills an advance and a stage together, and hard-gating that would
 * be inventing a policy the business has not asked for. When it does, the rule
 * lives here and every caller inherits it.
 */
export function nextUnlockedMilestone(
  entries: readonly MilestoneBillingEntry[],
): MilestoneBillingEntry | null {
  const priced = [...entries]
    .filter((e) => e.paymentPercent !== null)
    .sort((a, b) => a.position - b.position);

  return priced[paidThrough(entries)] ?? null;
}

/** Whether a milestone is clear to bill, and why not when it is not. */
export function milestoneInvoiceability(milestone: {
  status: string;
  amountMinor: number;
  paymentPercent: number | null;
}): { ok: true } | { ok: false; reason: string } {
  if (milestone.paymentPercent === null) {
    return {
      ok: false,
      reason: 'This milestone carries no payment share, so there is nothing to invoice.',
    };
  }
  if (milestone.status === 'rejected') {
    return { ok: false, reason: 'A rejected milestone cannot be invoiced.' };
  }
  if (!Number.isInteger(milestone.amountMinor) || milestone.amountMinor <= 0) {
    return { ok: false, reason: 'This milestone has no amount. Configure the payment plan first.' };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Refunds — gap G-005
// ═══════════════════════════════════════════════════════════════════════════

/** Matches the status CHECK on finance.refunds. */
export const REFUND_STATUSES = ['requested', 'recorded', 'refused'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const requestRefundSchema = z.object({
  invoiceId: z.uuid(),
  amountMinor: z.number().int().positive('A refund needs an amount'),
  /**
   * Required, and not for tidiness. A refund with no stated reason is an
   * unexplained withdrawal from the business, and the person asking why will
   * be asking months later.
   */
  reason: z.string().trim().min(1, 'Say why').max(1000),
});

export type RequestRefundInput = z.infer<typeof requestRefundSchema>;

export const recordRefundSchema = z.object({
  refundId: z.uuid(),
  /**
   * The bank or gateway reference for the money that actually left. Required:
   * it is both the evidence and the idempotency key, so the same reference
   * twice is one refund rather than two.
   */
  providerRefundId: z.string().trim().min(3, 'The transfer reference').max(200),
});

export type RecordRefundInput = z.infer<typeof recordRefundSchema>;
