import { z } from 'zod';

import { containsSecretValue } from '@/modules/projects/specialist-drafts';

/**
 * What the three Phase 9 finance agents may PROPOSE: pure, so the workflow and its tests share one definition.
 *
 * STUB-PROVEN ONLY. No real model has run any of this. These are the schemas a finance agent's answer must satisfy and the rules that refuse an answer
 * BEFORE it reaches the database door (`finance.record_finance_proposal`), which refuses the same things again.
 *
 * A finance agent PROPOSES. A proposal is never a fact: it never verifies a payment, never changes an amount, never records a refund, never decides a
 * waiver, never sends a client message and never closes a book. A Finance person or Admin who did NOT ask for the run accepts or rejects it.
 * Phase 9 plan section 9 / spec section 5 ("Prohibited Actions") are what the rules below encode.
 */

export const FINANCE_AGENTS = ['finance_reconciliation', 'finance_communication', 'finance_close'] as const;
export type FinanceAgent = (typeof FINANCE_AGENTS)[number];

export const PROPOSAL_KINDS = ['reconciliation_finding', 'anomaly_flag', 'reminder_draft', 'close_readiness_note', 'exception_classification'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** Each agent writes only its own kinds (the table CHECK and the door say the same). */
export const AGENT_KINDS: Record<FinanceAgent, readonly ProposalKind[]> = {
  finance_reconciliation: ['reconciliation_finding', 'anomaly_flag'],
  finance_communication: ['reminder_draft'],
  finance_close: ['close_readiness_note', 'exception_classification'],
};

export const EXCEPTION_KINDS = [
  'wrong_amount', 'wrong_account', 'unclear_proof', 'gateway_mismatch', 'overdue', 'overpayment', 'unmatched_payment', 'duplicate_payment', 'refund_dispute', 'chargeback', 'tax_correction', 'waiver_request', 'other',
] as const;

// ═══ the answer's shape ══════════════════════════════════════════════════

const text = (max: number) => z.string().trim().min(1).max(max);

export const proposalSchema = z
  .object({
    kind: z.enum(PROPOSAL_KINDS),
    summary: text(2000),
    detail: text(4000).nullable(),
    evidenceRefs: z.array(text(80)).max(20),
    submissionId: z.string().uuid().nullable(),
    draftBody: text(2000).nullable(),
    amountMinor: z.number().int().positive().nullable(),
    exceptionKind: z.enum(EXCEPTION_KINDS).nullable(),
  })
  .strict();

export const financeProposalsSchema = z.object({ proposals: z.array(proposalSchema).min(1).max(20) }).strict();
export type FinanceProposalsAnswer = z.infer<typeof financeProposalsSchema>;
export type FinanceProposal = z.infer<typeof proposalSchema>;

export function financeProposalsJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...PROPOSAL_KINDS] },
            summary: { type: 'string', description: 'What you found, in plain words, at most 2000 characters.' },
            detail: { type: ['string', 'null'] },
            evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'Only references from the facts you were given, e.g. invoice:<id>. A finding, a flag and a classification need at least one.' },
            submissionId: { type: ['string', 'null'], description: 'A payment submission id from the facts, when the proposal is about one; otherwise null.' },
            draftBody: { type: ['string', 'null'], description: 'reminder_draft only: the message wording; null otherwise.' },
            amountMinor: { type: ['integer', 'null'], description: 'reminder_draft only: the invoice outstanding balance from the facts, in minor units; null otherwise.' },
            exceptionKind: { type: ['string', 'null'], enum: [...EXCEPTION_KINDS, null], description: 'exception_classification only; null otherwise.' },
          },
          required: ['kind', 'summary', 'detail', 'evidenceRefs', 'submissionId', 'draftBody', 'amountMinor', 'exceptionKind'],
          additionalProperties: false,
        },
      },
    },
    required: ['proposals'],
    additionalProperties: false,
  };
}

// ═══ what the workflow read, and so what the model may cite ═════════════

export type FinanceFacts = {
  agent: FinanceAgent;
  projectName: string;
  currency: string;
  /** The database's own position (`finance.project_close_position`): the model reads it, never recomputes it. */
  position: {
    result: string;
    totals: Record<string, number | string | null>;
    milestones: { name: string; plannedMinor: number; invoicedMinor: number; verifiedNetMinor: number; waivedMinor: number; outstandingMinor: number; unverifiedMinor: number }[];
    blockers: { code: string; reason: string; ref: string | null }[];
  };
  invoices: { id: string; number: string; status: string; totalMinor: number; outstandingMinor: number; dueAt: string | null }[];
  submissions: { id: string; invoiceId: string; status: string; amountMinor: number; reference: string | null }[];
  payments: { id: string; invoiceId: string; amountMinor: number; verified: boolean }[];
  exceptions: { id: string; kind: string; blocking: boolean; reason: string }[];
  milestoneIds: { id: string; name: string }[];
  waivers: { id: string; status: string; amountMinor: number }[];
  /** reminder drafts only: the one invoice the request is about. */
  invoice: { id: string; number: string; status: string; outstandingMinor: number; dueAt: string | null; daysOverdue: number | null } | null;
};

export function allowedEvidenceRefs(f: FinanceFacts): string[] {
  return [
    ...f.invoices.map((i) => `invoice:${i.id}`),
    ...f.submissions.map((s) => `submission:${s.id}`),
    ...f.payments.map((p) => `payment:${p.id}`),
    ...f.exceptions.map((e) => `exception:${e.id}`),
    ...f.milestoneIds.map((m) => `milestone:${m.id}`),
    ...f.waivers.map((w) => `waiver:${w.id}`),
  ];
}

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;

export function renderFinanceFacts(f: FinanceFacts): string {
  const t = f.position.totals;
  const lines: string[] = [
    `Agent: ${f.agent}. Project: ${f.projectName}. Currency: ${f.currency}. All figures below were computed by the database from VERIFIED money; do not recompute them.`,
    `Position result: ${f.position.result}. Totals (minor units): ${Object.entries(t).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
    'Milestones:',
    ...f.position.milestones.map((m) => `- ${m.name}: planned ${m.plannedMinor}, invoiced ${m.invoicedMinor}, verified net ${m.verifiedNetMinor}, waived ${m.waivedMinor}, outstanding ${m.outstandingMinor}, unverified ${m.unverifiedMinor}`),
    'Blockers the close currently has:',
    ...(f.position.blockers.length ? f.position.blockers.map((b) => `- ${b.code}: ${b.reason}${b.ref ? ` (${b.ref})` : ''}`) : ['- none']),
    'Records you may cite:',
    ...f.invoices.map((i) => `- invoice:${i.id} ${i.number} [${i.status}] total ${money(i.totalMinor, f.currency)}, outstanding ${i.outstandingMinor} minor${i.dueAt ? `, due ${i.dueAt}` : ''}`),
    ...f.submissions.map((s) => `- submission:${s.id} [${s.status}] ${money(s.amountMinor, f.currency)}${s.reference ? ` ref ${s.reference}` : ''} on invoice:${s.invoiceId}`),
    ...f.payments.map((p) => `- payment:${p.id} ${money(p.amountMinor, f.currency)} ${p.verified ? 'VERIFIED' : 'NOT VERIFIED'} on invoice:${p.invoiceId}`),
    ...f.exceptions.map((e) => `- exception:${e.id} ${e.kind}${e.blocking ? ' (blocking)' : ''}: ${e.reason}`),
    ...f.milestoneIds.map((m) => `- milestone:${m.id} ${m.name}`),
    ...f.waivers.map((w) => `- waiver:${w.id} [${w.status}] ${w.amountMinor} minor`),
  ];
  if (f.invoice) {
    lines.push(
      `The reminder is about invoice ${f.invoice.number} [${f.invoice.status}]. Its REAL outstanding balance is ${f.invoice.outstandingMinor} minor units${f.invoice.dueAt ? `; due ${f.invoice.dueAt}` : ''}${f.invoice.daysOverdue !== null ? `; ${f.invoice.daysOverdue} days overdue` : ''}. amountMinor MUST equal ${f.invoice.outstandingMinor}.`,
    );
  }
  return lines.join('\n');
}

// ═══ the prompts (text for a model: the checks below are what actually bind) ═══

const COMMON_PROMPT = [
  'You PROPOSE for a person to review. You never verify a payment, never change an amount, never issue or approve a refund, never decide a waiver, never send a message and never close a financial period or project.',
  'Answer with JSON only. Cite only the records in the facts you were given (invoice:<id>, submission:<id>, payment:<id>, exception:<id>, milestone:<id>, waiver:<id>); never invent a record or a figure.',
  'Unverified money is not received money. A client saying they paid, or a screenshot, is not a payment. Never guess tax treatment, a GST rate or a legal position. Never write a secret value, a bank or gateway credential or an account number.',
].join(' ');

export const FINANCE_PROFILES: Record<FinanceAgent, { agent: FinanceAgent; kinds: readonly ProposalKind[]; prompt: string }> = {
  finance_reconciliation: {
    agent: 'finance_reconciliation',
    kinds: AGENT_KINDS.finance_reconciliation,
    prompt: `${COMMON_PROMPT} You are the Finance Reconciliation agent: compare what the records show and identify drift (reconciliation_finding) or something that looks wrong (anomaly_flag). Each cites its evidence. You identify; you rewrite nothing, and you do not say a payment was received or verified.`,
  },
  finance_communication: {
    agent: 'finance_communication',
    kinds: AGENT_KINDS.finance_communication,
    prompt: `${COMMON_PROMPT} You are the Finance Communication agent: draft one polite, professional payment reminder (reminder_draft) for the ONE invoice you are given. Quote the outstanding balance exactly as given in amountMinor. Never state or imply that a payment was received. Never offer or hint at a discount, waiver, write-off, refund, extension, deferral, instalment or payment plan. Never include an account number or any payment credential. You draft; a person decides whether it is ever sent.`,
  },
  finance_close: {
    agent: 'finance_close',
    kinds: AGENT_KINDS.finance_close,
    prompt: `${COMMON_PROMPT} You are the Finance Close agent: read the project's financial position and say plainly whether it can close and what stands in the way (close_readiness_note), or classify something that needs a person's attention as an exception kind (exception_classification). You never say the project IS closed or complete; closing is a person's act.`,
  },
};

// ═══ the checks ═════════════════════════════════════════════════════════

/** A claim that money arrived. Mirrors the database door. */
export const CLAIMS_PAYMENT_RECEIVED = /(received your payment|payment (has been |was |is )?(received|verified|confirmed)|we have received|marked (as )?paid|thank you for (the|your) payment)/i;
/** A promise nobody has authorised: discount, waiver, refund, deferral, plan. Mirrors the database door. */
export const PROMISES_A_CONCESSION = /(waive|waiver|write[- ]?off|discount|refund|defer|deferral|extension|extend the due|instal+ment|payment plan|forgive|concession)/i;
/** A statement that the books are closed or the project is complete (a close agent proposes readiness, it does not declare). */
const DECLARES_CLOSED = /\b(is (now )?(financially )?closed|has been closed|i have closed|books are closed|project is complete(d)?|marked (as )?complete)\b/i;

export function looksLikeAccountNumber(s: string): boolean {
  return /[0-9]{9,}/.test(s) || /([0-9]{4}[ -]){3}[0-9]{2,4}/.test(s);
}

export type ProposalsCheck = { ok: true; proposals: FinanceProposal[] } | { ok: false; reason: string };
const refuse = (reason: string): ProposalsCheck => ({ ok: false, reason });

const textOf = (p: FinanceProposal) => [p.summary, p.detail ?? '', p.draftBody ?? '', ...p.evidenceRefs].join('\n');

/**
 * The answer against the facts the workflow read. REFUSED, never repaired: one bad proposal refuses the whole answer, because a model that is wrong
 * about one record is not trusted about the rest. Nothing here records anything.
 */
export function checkFinanceProposals(agent: FinanceAgent, answer: FinanceProposalsAnswer, facts: FinanceFacts): ProposalsCheck {
  const profile = FINANCE_PROFILES[agent];
  const allowed = new Set(allowedEvidenceRefs(facts));
  const seen = new Set<string>();

  for (const p of answer.proposals) {
    const where = p.kind;
    if (!profile.kinds.includes(p.kind)) return refuse(`${agent} may not propose a ${p.kind}`);
    if (containsSecretValue(textOf(p))) return refuse('a proposal carries a secret value');
    const dup = `${p.kind}:${p.summary}`;
    if (seen.has(dup)) return refuse(`${where}: proposed twice`);
    seen.add(dup);
    const unseen = p.evidenceRefs.find((r) => !allowed.has(r));
    if (unseen) return refuse(`${where}: it cites a record that was not in the facts ("${unseen}")`);
    if (p.submissionId !== null && !facts.submissions.some((s) => s.id === p.submissionId)) return refuse(`${where}: that payment submission was not in the facts`);
    if (p.kind !== 'reminder_draft' && p.kind !== 'close_readiness_note' && p.evidenceRefs.length === 0) return refuse(`${where}: a finding, a flag and a classification cite evidence`);
    if ((p.kind === 'reminder_draft') !== (p.draftBody !== null && p.amountMinor !== null)) return refuse(`${where}: only a reminder draft carries a body and an amount, and it carries both`);
    if ((p.kind === 'exception_classification') !== (p.exceptionKind !== null)) return refuse(`${where}: only an exception classification names an exception kind`);

    if (p.kind === 'reminder_draft') {
      const inv = facts.invoice;
      if (!inv) return refuse(`${where}: there is no invoice to remind about`);
      if (!['issued', 'partially_paid', 'overdue'].includes(inv.status)) return refuse(`${where}: invoice ${inv.number} is ${inv.status}, so there is nothing to collect`);
      if (inv.outstandingMinor <= 0) return refuse(`${where}: nothing is owed on invoice ${inv.number}`);
      // the amount in a reminder is the database's balance, never the model's figure
      if (p.amountMinor !== inv.outstandingMinor) return refuse(`${where}: the amount must be the invoice's real outstanding balance (${inv.outstandingMinor}), not ${p.amountMinor}`);
      const body = p.draftBody ?? '';
      if (CLAIMS_PAYMENT_RECEIVED.test(body)) return refuse(`${where}: a reminder never claims a payment was received`);
      if (PROMISES_A_CONCESSION.test(body)) return refuse(`${where}: a reminder never promises a discount, waiver, refund, deferral or payment plan`);
      if (looksLikeAccountNumber(body)) return refuse(`${where}: a reminder carries no account number or payment credential`);
    }
    if ((p.kind === 'close_readiness_note') && DECLARES_CLOSED.test(textOf(p))) return refuse(`${where}: a close agent states readiness; it never says the project is closed or complete`);
    if ((p.kind === 'reconciliation_finding' || p.kind === 'anomaly_flag') && CLAIMS_PAYMENT_RECEIVED.test(`${p.summary}\n${p.detail ?? ''}`)) {
      return refuse(`${where}: a finding never asserts that a payment was received or verified; only a person verifies`);
    }
  }
  return { ok: true, proposals: answer.proposals };
}

/** The arguments `finance.record_finance_proposal` takes for one proposal (the workflow adds the request, the organization and the agent). */
export function doorArgsFor(p: FinanceProposal): Record<string, unknown> {
  return {
    p_kind: p.kind,
    p_summary: p.summary,
    p_detail: p.detail,
    p_evidence_refs: p.evidenceRefs,
    p_submission_id: p.submissionId,
    p_draft_body: p.draftBody,
    p_amount_minor: p.amountMinor,
    p_exception_kind: p.exceptionKind,
  };
}

/** Outcomes of the proposal door that are a good answer: the proposal exists (now, or from a redelivered run). */
export const GOOD_PROPOSAL_OUTCOMES: ReadonlySet<string> = new Set(['proposed', 'already_proposed']);
