import { z } from 'zod';

import { containsSecretValue } from './specialist-drafts';

/**
 * What the Phase 8 maintenance agents may PROPOSE: pure, so the workflows, the actions and the tests share one definition.
 *
 * STUB-PROVEN ONLY. No real model has run any of this. A proposal is a DRAFT a person decides: it never records a QA result, never names a commit as
 * verified, never approves or releases, never sets an amount and never verifies a payment. The database doors refuse the same things again.
 */

export const MAINTENANCE_AGENTS = ['bug_fix', 'regression_test'] as const;
export type MaintenanceAgent = (typeof MAINTENANCE_AGENTS)[number];
export const PLAN_KIND: Record<MaintenanceAgent, 'fix_plan' | 'regression_plan'> = { bug_fix: 'fix_plan', regression_test: 'regression_plan' };

export const JOB_KIND = {
  bug_fix: 'maintenance.bug_fix.plan',
  regression_test: 'maintenance.regression_test.plan',
  finance: 'finance.maintenance_billing.propose',
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);

export const maintenancePlanSchema = z
  .object({
    summary: text(2000),
    steps: z.array(text(500)).min(1).max(20),
    risks: z.array(text(500)).max(20),
    needsScopeChange: z.boolean(),
    recommendsSecurityReview: z.boolean(),
    evidenceRefs: z.array(text(300)).max(20),
  })
  .strict();
export type MaintenancePlanAnswer = z.infer<typeof maintenancePlanSchema>;

export function maintenancePlanJsonSchema(): Record<string, unknown> {
  const strings = (max: number) => ({ type: 'array', items: { type: 'string' }, maxItems: max });
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What to do and why, at most 2000 characters.' },
      steps: { ...strings(20), description: 'Ordered steps; at least one.' },
      risks: { ...strings(20), description: 'What could go wrong.' },
      needsScopeChange: { type: 'boolean', description: 'True when the request is really new scope: it then goes back to a Change Request.' },
      recommendsSecurityReview: { type: 'boolean' },
      evidenceRefs: { ...strings(20), description: 'Only references you were given.' },
    },
    required: ['summary', 'steps', 'risks', 'needsScopeChange', 'recommendsSecurityReview', 'evidenceRefs'],
    additionalProperties: false,
  };
}

export type MaintenanceFacts = {
  agent: MaintenanceAgent;
  kind: string;
  area: string;
  title: string;
  description: string | null;
  status: string;
  sensitive: boolean;
  commitRef: string | null;
  fixSummary: string | null;
  defect: { title: string; reproduction: string | null; expected: string | null; actual: string | null } | null;
  changeRequest: { requested: string; classification: string | null } | null;
  ticket: { title: string; coverage: string | null } | null;
  /** References the agent may cite, e.g. `defect:<id>`. */
  evidence: { ref: string; detail: string }[];
};

export function renderMaintenanceFacts(f: MaintenanceFacts): string {
  const lines = [
    `Work item (${f.kind}, ${f.area}${f.sensitive ? ', security-sensitive' : ''}): ${f.title}`,
    f.description ? `Description: ${f.description}` : null,
    `State: ${f.status}`,
    f.commitRef ? `Exact commit: ${f.commitRef}` : 'No commit has been submitted yet.',
    f.fixSummary ? `Developer summary: ${f.fixSummary}` : null,
    f.defect ? `Defect: ${f.defect.title}. Reproduction: ${f.defect.reproduction ?? 'none'}. Expected: ${f.defect.expected ?? 'unstated'}. Actual: ${f.defect.actual ?? 'unstated'}.` : null,
    f.changeRequest ? `Change request (${f.changeRequest.classification ?? 'unclassified'}): ${f.changeRequest.requested}` : null,
    f.ticket ? `Ticket (${f.ticket.coverage ?? 'unclassified'}): ${f.ticket.title}` : null,
    f.evidence.length ? `References you may cite:\n${f.evidence.map((e) => `- ${e.ref}: ${e.detail}`).join('\n')}` : 'No references are available to cite.',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

export const MAINTENANCE_PLAN_PROMPTS: Record<MaintenanceAgent, string> = {
  bug_fix: [
    'You plan a MINIMAL production fix for approved post-launch maintenance work. You only propose; a person decides.',
    'Reproduce first: if the work cannot be reproduced from what you are given, say so in a step and ask for evidence; do not guess a cause.',
    'If the request is really new scope, set needsScopeChange to true and say that it must return to a Change Request.',
    'Never claim a test passed, a defect is fixed or verified, a deployment happened, or work is complete. Never include a secret or credential. Cite only references you were given.',
  ].join('\n'),
  regression_test: [
    'You plan the REGRESSION and targeted tests for one exact commit of post-launch maintenance work. You only propose; a person records results.',
    'Name what to retest around the change, what a failure would look like, and whether a security review is warranted.',
    'Never claim a test passed or failed, never claim the change is verified or ready to release, never include a secret. Cite only references you were given.',
  ].join('\n'),
};

/** Statements that would be a RESULT, a completion or a deployment claim: a plan makes none. */
const FORBIDDEN_CLAIM = /\b(all tests (?:pass|passed)|tests? (?:pass|passed|are green)|verified|is fixed|has been fixed|ready to (?:release|ship|deploy)|approved|deployed to|released to|merged|work is complete|qa passed)\b/i;
const PRODUCTION_ACTION = /\b(deploy|release|publish|push)\b[^.\n]{0,40}\b(to\s+)?(prod|production|live)\b/i;

export type PlanCheck = { ok: true } | { ok: false; reason: string };

export function checkMaintenancePlan(agent: MaintenanceAgent, a: MaintenancePlanAnswer, facts: MaintenanceFacts): PlanCheck {
  const all = [a.summary, ...a.steps, ...a.risks, ...a.evidenceRefs].join('\n');
  if (containsSecretValue(all)) return { ok: false, reason: 'the proposal contains a secret value' };
  if (FORBIDDEN_CLAIM.test(a.summary) || a.steps.some((s) => FORBIDDEN_CLAIM.test(s))) return { ok: false, reason: 'a plan claims a result, a verification, an approval or a completion: only people record those' };
  if (PRODUCTION_ACTION.test(all)) return { ok: false, reason: 'a plan does not deploy or release to production: that is a person\'s recorded act' };
  const allowed = new Set(facts.evidence.map((e) => e.ref));
  const stray = a.evidenceRefs.find((r) => !allowed.has(r));
  if (stray) return { ok: false, reason: `the proposal cites a reference it was not given: ${stray}` };
  if (agent === 'regression_test' && facts.commitRef === null) return { ok: false, reason: 'a regression plan is about a commit that exists' };
  if (agent === 'bug_fix' && facts.kind === 'enhancement') return { ok: false, reason: 'the Bug Fix agent plans fixes; an enhancement is planned under its change request' };
  return { ok: true };
}

export function planDoorArgs(agent: MaintenanceAgent, a: MaintenancePlanAnswer, commitRef: string | null) {
  return {
    p_kind: PLAN_KIND[agent],
    p_summary: a.summary,
    p_steps: a.steps,
    p_risks: a.risks,
    p_needs_scope_change: a.needsScopeChange,
    p_recommends_security_review: a.recommendsSecurityReview,
    p_evidence_refs: a.evidenceRefs,
    p_commit_ref: commitRef,
  };
}

// ═══ Finance: a narrative and a reminder text, never an amount ═══════════

export const billingProposalSchema = z
  .object({ narrative: text(1000), reminderText: text(1500).nullable() })
  .strict();
export type BillingProposalAnswer = z.infer<typeof billingProposalSchema>;

export function billingProposalJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      narrative: { type: 'string', description: 'A short note for the person deciding, at most 1000 characters. No amounts.' },
      reminderText: { type: ['string', 'null'], description: 'For a payment reminder only: polite text naming the invoice number. Null otherwise.' },
    },
    required: ['narrative', 'reminderText'],
    additionalProperties: false,
  };
}

export type BillingFacts = {
  kind: 'maintenance_invoice' | 'change_request_invoice' | 'payment_reminder';
  clientName: string | null;
  invoiceNumber: string | null;
  /** Verified-money balance, in minor units, computed by the database. */
  balanceMinor: number | null;
  currency: string | null;
  planName: string | null;
  changeRequestText: string | null;
  quotedLines: { description: string; quantity: number }[];
};

export function renderBillingFacts(f: BillingFacts): string {
  return [
    `Kind: ${f.kind.replace(/_/g, ' ')}`,
    f.clientName ? `Client: ${f.clientName}` : null,
    f.planName ? `Maintenance plan: ${f.planName}` : null,
    f.changeRequestText ? `Change request: ${f.changeRequestText}` : null,
    f.invoiceNumber ? `Invoice number: ${f.invoiceNumber}` : null,
    f.kind === 'payment_reminder' ? 'The balance is held by the system and shown to the person beside your text. Do not state it.' : `Quoted items (the prices are fixed by a person; do not state any amount):\n${f.quotedLines.map((l) => `- ${l.description} x${l.quantity}`).join('\n')}`,
  ].filter((l): l is string => l !== null).join('\n');
}

export const BILLING_PROMPT = [
  'You prepare a DRAFT for a person to decide: a short note about a maintenance or change-request invoice, or a polite payment reminder text.',
  'You set no price and state no amount: amounts come from a quote a person made and from verified payment records. A payment reminder names the invoice number.',
  'Never claim a payment was received, verified or confirmed. A screenshot or a message is a submission, not verification. Never include a secret. Never pressure the client.',
].join('\n');

const AMOUNT = /(?:₹|\brs\.?\s?|\binr\s?|\$|€)\s*\d|\d[\d,]*(?:\.\d+)?\s?(?:rupees|inr|usd)\b/i;
const PAYMENT_CLAIM = /\b(payment (?:received|verified|confirmed|cleared)|we (?:have )?received your payment|has been paid|is paid|paid in full|verified your payment)\b/i;
const PRESSURE = /\b(final notice|last warning|legal action|service (?:will be )?(?:suspended|terminated)|immediately or)\b/i;

export function checkBillingProposal(a: BillingProposalAnswer, facts: BillingFacts): PlanCheck {
  const all = `${a.narrative}\n${a.reminderText ?? ''}`;
  if (containsSecretValue(all)) return { ok: false, reason: 'the proposal contains a secret value' };
  if (AMOUNT.test(all)) return { ok: false, reason: 'the proposal states an amount: amounts come from the quote and the payment records, never from the agent' };
  if (PAYMENT_CLAIM.test(all)) return { ok: false, reason: 'the proposal claims a payment was received or verified: only an Admin verifies a payment' };
  if (facts.kind === 'payment_reminder') {
    if (!a.reminderText) return { ok: false, reason: 'a reminder proposal needs the reminder text' };
    if (facts.invoiceNumber && !a.reminderText.includes(facts.invoiceNumber)) return { ok: false, reason: 'the reminder does not name its invoice' };
    if (PRESSURE.test(all)) return { ok: false, reason: 'the reminder pressures the client; reminders are accurate and polite' };
  } else if (a.reminderText) {
    return { ok: false, reason: 'an invoice proposal carries no reminder text' };
  }
  return { ok: true };
}

/** Door outcomes in words a person reads. Anything not listed is shown as written. */
export const MAINTENANCE_OUTCOME_WORDS: Record<string, string> = {
  unauthorized_work: 'Work needs a ticket, a defect or an approved change request. Nothing is done as free scope.',
  enhancement_needs_a_change_request: 'An enhancement needs an approved change request.',
  out_of_scope_needs_a_change_request: 'That ticket is out of scope. Raise a change request instead of doing it as maintenance.',
  new_project_is_not_maintenance: 'A new project is not maintenance.',
  change_request_not_approved: 'The change request is not approved yet.',
  change_request_unpaid: 'The paid change has no verified payment yet.',
  no_handover: 'The project has no delivered handover: there is nothing to maintain yet.',
  exact_commit_required: 'Give the full 40-character commit hash.',
  rollback_required: 'A rollback plan and its owner are required.',
  commit_frozen: 'The commit of an approved release is frozen. Open new work for different code.',
  self_review: 'The person who submitted the commit cannot be its QA.',
  stale_commit: 'That result is for a different commit than the one submitted now.',
  gates_open: 'Not every gate holds yet.',
  approver_is_the_author: 'The person who opened, built or requested this cannot approve it.',
  not_authorized: 'You do not have permission to do that.',
  self_acceptance: 'You asked for this, so someone else decides.',
  invoice_not_collectible: 'That invoice is paid, void or not issued: no reminder is prepared.',
  already_paid_in_full: 'That invoice is paid in full on verified money.',
  plan_not_accepted: 'The plan has no accepted quote yet.',
  amount_differs_from_the_quoted_price: 'That invoice does not carry the quoted total. Amounts are never changed here.',
  requester_cannot_approve: 'You requested this exception, so the owner decides it, not you.',
  amount_differs_from_the_accepted_price: 'That invoice does not carry the total the client accepted. Amounts are never changed here.',
  no_accepted_price: 'The plan has no accepted quote for this cycle, so there is no price to bind the invoice to.',
  bad_cycle: 'A cycle must end after it starts.',
  cycle_too_long: 'That cycle is longer than the plan\'s billing model allows.',
  cycle_overlaps_a_billed_cycle: 'That cycle overlaps a cycle already billed on this plan.',
  cycle_outside_the_plan_period: 'That cycle falls outside the plan\'s own start and end dates.',
  cycle_is_not_the_accepted_renewal: 'A renewal invoice must cover exactly the renewal period the client accepted.',
  cycle_already_billed: 'That cycle already has a different invoice linked to it.',
};

export const outcomeWords = (outcome: string): string => MAINTENANCE_OUTCOME_WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`;
