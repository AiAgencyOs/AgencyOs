import { z } from 'zod';

import { containsSecretValue } from './specialist-drafts';

/**
 * What the Phase 8A agents may PROPOSE (Support, Customer Success, Upsell): pure, so the workflows, the panel and the tests share one definition.
 *
 * An agent here only DRAFTS. The Support agent proposes a classification and a reply DRAFT; the Customer Success agent drafts a check-in AGENDA; the
 * Upsell agent records an opportunity as DETECTED from evidence. None of them sends, quotes, prices, discounts, classifies for real, qualifies, hands off,
 * completes a check-in or approves anything: those are person-only doors the service role cannot execute. The rules below are held again in the
 * database (the price pattern is a CHECK on the reply drafts, the agenda and the opportunity trigger); tests/phase-eight-cs-workflows.test.ts holds this
 * pattern equal to the migrations'. Nothing in this module has been run against a real model.
 */

export const PHASE_EIGHT_AGENTS = ['support', 'customer_success', 'upsell'] as const;

export const SUPPORT_CLASSIFICATIONS = ['how_to', 'warranty_bug', 'maintenance', 'minor_change', 'change_request', 'new_project', 'disputed'] as const;
export const AGENDA_KINDS = ['confirm_access', 'confirm_use', 'unresolved_issue', 'training_need', 'feedback_to_collect', 'renewal_timing', 'possible_new_work'] as const;
export const OPPORTUNITY_KINDS = ['change_request', 'new_project'] as const;
export const EVIDENCE_TYPES = ['ticket', 'check_in', 'upsell_signal'] as const;

/** A price, an amount or a discount: held equal to the CHECK on projects.support_reply_drafts and projects.cs_check_ins (a test reads both). */
export const PRICE_PATTERN = '(₹|€|\\$)\\s*[0-9]|\\m(rs\\.?|inr|usd|eur)\\s*[0-9]|[0-9]\\s*(rupees|dollars|inr|usd)\\M|discount|% off';
/** The JS twin of the pattern: \m and \M are PostgreSQL word anchors, \b here. */
const PRICE_RE = /(₹|€|\$)\s*[0-9]|\b(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\b|discount|% off/i;
/** A commitment or a claim of work done that nothing recorded: an agent promises no refund, no free work, no fix date, and claims no external success. */
const COMMITMENT_RE = /\b(refund|free of charge|no charge|at no cost|for free|guarantee[sd]?|we(?:'ve| have| already) (fixed|resolved|deployed|released|sent|upgraded)|will be (fixed|resolved|ready|live) (by|within|in)\b|is (now )?(fixed|resolved|live))\b/i;

export const namesAPrice = (text: string): boolean => PRICE_RE.test(text);
export const makesACommitment = (text: string): boolean => COMMITMENT_RE.test(text);
/** Text an agent writes that a person will read or send: no price, no commitment, no secret. */
export function unsafeText(text: string): 'price' | 'commitment' | 'secret' | null {
  if (namesAPrice(text)) return 'price';
  if (makesACommitment(text)) return 'commitment';
  if (containsSecretValue(text)) return 'secret';
  return null;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const maybe = (max: number) => z.string().trim().min(1).max(max).nullable();

// ═══ Support ═══════════════════════════════════════════════════════════════════════════════════

export const supportProposalSchema = z
  .object({
    proposedClassification: z.enum(SUPPORT_CLASSIFICATIONS).nullable(),
    rationale: text(600),
    draftReply: maybe(1500),
    language: z.string().regex(/^[a-z]{2,8}(-[A-Za-z0-9]{2,8})?$/).nullable(),
  })
  .strict();
export type SupportProposal = z.infer<typeof supportProposalSchema>;

export type SupportFacts = {
  title: string;
  description: string | null;
  status: string;
  raisedWithinWarranty: boolean;
  warrantyWindow: string;
  activePlans: { name: string; version: number; status: string; startsOn: string | null; endsOn: string | null }[];
  recent: { title: string; classification: string | null }[];
};

export type Verdict = { ok: true } | { ok: false; reason: string };

export function checkSupportProposal(p: SupportProposal, facts: SupportFacts): Verdict {
  if (p.proposedClassification === null && p.draftReply === null) return { ok: false, reason: 'nothing is proposed' };
  const rationaleProblem = unsafeText(p.rationale);
  if (rationaleProblem) return { ok: false, reason: `the rationale contains a ${rationaleProblem}` };
  if (p.draftReply !== null) {
    const problem = unsafeText(p.draftReply);
    if (problem) return { ok: false, reason: `the draft reply contains a ${problem}` };
  }
  // an agent does not call a defect covered when the warranty window does not reach the day it was raised: that is a person's coverage decision
  if (p.proposedClassification === 'warranty_bug' && !facts.raisedWithinWarranty) return { ok: false, reason: 'the issue was raised outside the warranty window, so it cannot be proposed as a warranty bug' };
  if (p.proposedClassification === 'maintenance' && facts.activePlans.length === 0) return { ok: false, reason: 'no active maintenance plan exists, so it cannot be proposed as maintenance' };
  return { ok: true };
}

export const supportSystemPrompt = [
  'You help a person handle ONE post-launch support ticket. You only PROPOSE: a classification and a reply DRAFT a person will read, edit and send themselves.',
  'Classify as exactly one of: how_to (the client needs help using something that works), warranty_bug (something delivered is broken, within the warranty window shown),',
  'maintenance (routine upkeep a maintenance plan covers), minor_change (a small change a plan covers), change_request (a material new feature), new_project (a separate module or platform),',
  'or disputed (unclear: a person decides). Never call new functionality a bug. When unsure, propose disputed with the reason; do not guess.',
  'The draft reply is addressed to the client in their language, plain and polite. It names no price, no discount, no refund, no free work, no deadline and no guarantee, and it never',
  'claims something was fixed, sent or deployed. It asks one clear question if you need more, otherwise it says the team is looking into it.',
  'Use only the facts below. Never write a secret, a token or a password.',
].join(' ');

export function renderSupportFacts(f: SupportFacts): string {
  return [
    `Ticket title: ${f.title}`,
    `Client's message: ${f.description ?? '(none)'}`,
    `Status: ${f.status}`,
    `Warranty: ${f.warrantyWindow}. Raised inside the window: ${f.raisedWithinWarranty ? 'yes' : 'no'}.`,
    `Active maintenance plans: ${f.activePlans.length === 0 ? 'none' : f.activePlans.map((p) => `${p.name} v${p.version} (${p.status}, ${p.startsOn ?? '?'} to ${p.endsOn ?? 'open'})`).join('; ')}`,
    `Recent tickets on this project: ${f.recent.length === 0 ? 'none' : f.recent.map((r) => `${r.title} [${r.classification ?? 'unclassified'}]`).join('; ')}`,
  ].join('\n');
}

export function supportJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['proposedClassification', 'rationale', 'draftReply', 'language'],
    properties: {
      proposedClassification: { type: ['string', 'null'], enum: [...SUPPORT_CLASSIFICATIONS, null], description: 'Your proposed classification, or null if you only draft a reply.' },
      rationale: { type: 'string', description: 'Why, in one or two sentences, from the facts only. At most 600 characters.' },
      draftReply: { type: ['string', 'null'], description: 'A reply DRAFT for a person to send, or null. At most 1500 characters. No price, discount, refund, free work, deadline or guarantee.' },
      language: { type: ['string', 'null'], description: 'The reply language code such as en or hi, or null.' },
    },
  };
}

// ═══ Customer Success ══════════════════════════════════════════════════════════════════════════

export const agendaSchema = z
  .object({
    points: z.array(z.object({ kind: z.enum(AGENDA_KINDS), note: text(300), ticketId: z.uuid().nullable() }).strict()).min(1).max(8),
  })
  .strict();
export type Agenda = z.infer<typeof agendaSchema>;

export type AgendaFacts = {
  projectName: string;
  healthStatus: string | null;
  signals: { signal: string; value: string; level: string }[];
  openTickets: { id: string; title: string; priority: string | null; status: string }[];
  plans: { name: string; status: string; endsOn: string | null }[];
  lastCheckIns: { kind: string; outcome: string | null }[];
  warrantyEndsOn: string | null;
};

const AGENDA_LABEL: Record<(typeof AGENDA_KINDS)[number], string> = {
  confirm_access: 'Confirm access',
  confirm_use: 'Confirm the product is being used',
  unresolved_issue: 'Unresolved issue',
  training_need: 'Training need',
  feedback_to_collect: 'Feedback to collect',
  renewal_timing: 'Renewal timing',
  possible_new_work: 'Possible new work (name it only; do not price it)',
};

export function checkAgenda(a: Agenda, facts: AgendaFacts): Verdict {
  const openIds = new Set(facts.openTickets.map((t) => t.id));
  const recovery = facts.healthStatus === 'at_risk' || facts.healthStatus === 'critical';
  for (const p of a.points) {
    const problem = unsafeText(p.note);
    if (problem) return { ok: false, reason: `a point contains a ${problem}` };
    if (p.kind === 'unresolved_issue' && (!p.ticketId || !openIds.has(p.ticketId))) return { ok: false, reason: 'an unresolved issue must cite an open ticket from the facts' };
    if (p.kind !== 'unresolved_issue' && p.ticketId !== null && !openIds.has(p.ticketId)) return { ok: false, reason: 'a point cites a ticket that is not open on this project' };
    if (p.kind === 'possible_new_work' && recovery) return { ok: false, reason: 'the account is at risk: recovery comes first, so no new work is raised' };
    if (p.kind === 'renewal_timing' && facts.plans.length === 0) return { ok: false, reason: 'there is no maintenance plan to time a renewal for' };
  }
  return { ok: true };
}

export function renderAgenda(a: Agenda): string {
  return a.points.map((p, i) => `${i + 1}. ${AGENDA_LABEL[p.kind]}: ${p.note}`).join('\n');
}

export const agendaSystemPrompt = [
  'You prepare the AGENDA for ONE post-launch check-in a person will hold with a client. You do not contact anyone, send anything or record any outcome.',
  'Choose agenda points only from these kinds: confirm_access, confirm_use, unresolved_issue (cite an open ticket id from the facts), training_need, feedback_to_collect, renewal_timing (only if a plan exists),',
  'possible_new_work (name a need only; never a price; never when the account is at risk or critical).',
  'Use only the recorded facts. Do not invent satisfaction, usage, VIP status or a problem. No price, discount, refund or promise. Never write a secret.',
].join(' ');

export function renderAgendaFacts(f: AgendaFacts): string {
  return [
    `Project: ${f.projectName}`,
    `Derived health: ${f.healthStatus ?? 'unknown'}. Signals: ${f.signals.map((s) => `${s.signal}=${s.value} (${s.level})`).join('; ')}`,
    `Open tickets: ${f.openTickets.length === 0 ? 'none' : f.openTickets.map((t) => `${t.id} [${t.priority ?? 'unprioritized'}, ${t.status}] ${t.title}`).join('; ')}`,
    `Maintenance plans: ${f.plans.length === 0 ? 'none' : f.plans.map((p) => `${p.name} ${p.status} ends ${p.endsOn ?? 'open'}`).join('; ')}`,
    `Warranty ends: ${f.warrantyEndsOn ?? 'no warranty'}`,
    `Recent completed check-ins: ${f.lastCheckIns.length === 0 ? 'none' : f.lastCheckIns.map((c) => `${c.kind}: ${c.outcome ?? 'no outcome'}`).join('; ')}`,
  ].join('\n');
}

export function agendaJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['points'],
    properties: {
      points: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'note', 'ticketId'],
          properties: {
            kind: { type: 'string', enum: [...AGENDA_KINDS] },
            note: { type: 'string', description: 'What to raise and why, from the facts. At most 300 characters. No price.' },
            ticketId: { type: ['string', 'null'], description: 'The open ticket this point is about (required for unresolved_issue), else null.' },
          },
        },
      },
    },
  };
}

// ═══ Upsell ════════════════════════════════════════════════════════════════════════════════════

export const opportunitySchema = z
  .object({
    opportunity: z
      .object({
        kind: z.enum(OPPORTUNITY_KINDS),
        need: z.string().trim().min(10).max(1200),
        requestedOutcome: maybe(500),
        urgency: z.enum(['low', 'normal', 'high']),
        stakeholders: maybe(300),
        constraints: maybe(500),
        evidence: z.array(z.object({ type: z.enum(EVIDENCE_TYPES), id: z.uuid() }).strict()).min(1).max(10),
      })
      .strict()
      .nullable(),
    reason: text(600),
  })
  .strict();
export type OpportunityProposal = z.infer<typeof opportunitySchema>;

export type OpportunityFacts = {
  projectName: string;
  tickets: { id: string; title: string; description: string | null; classification: string | null }[];
  checkIns: { id: string; kind: string; outcome: string | null }[];
  signals: { id: string; kind: string }[];
  healthStatus: string | null;
};

export function checkOpportunity(p: OpportunityProposal, facts: OpportunityFacts): Verdict {
  const reasonProblem = unsafeText(p.reason);
  if (reasonProblem) return { ok: false, reason: `the reason contains a ${reasonProblem}` };
  if (p.opportunity === null) return { ok: true };
  const o = p.opportunity;
  for (const [label, value] of [['need', o.need], ['requested outcome', o.requestedOutcome], ['stakeholders', o.stakeholders], ['constraints', o.constraints]] as const) {
    if (value === null) continue;
    const problem = unsafeText(value);
    if (problem) return { ok: false, reason: `the ${label} contains a ${problem}` };
  }
  const known = new Map<string, string | null>();
  for (const t of facts.tickets) known.set(`ticket:${t.id}`, t.classification);
  for (const c of facts.checkIns) known.set(`check_in:${c.id}`, null);
  for (const s of facts.signals) known.set(`upsell_signal:${s.id}`, null);
  for (const e of o.evidence) {
    const key = `${e.type}:${e.id}`;
    if (!known.has(key)) return { ok: false, reason: 'the evidence is not a record of this project in the facts' };
    // already covered by warranty, maintenance or the approved scope is an obligation, not an opportunity
    if (e.type === 'ticket' && known.get(key) !== 'change_request' && known.get(key) !== 'new_project') return { ok: false, reason: 'a ticket that is not classified as out of scope is not evidence of an opportunity' };
  }
  return { ok: true };
}

export const opportunitySystemPrompt = [
  'You look at ONE completed project\'s recorded evidence and decide whether there is a LEGITIMATE expansion opportunity. Most of the time there is not: answer opportunity null with the reason.',
  'An opportunity needs evidence: a ticket a person classified as out of scope, a completed check-in, or an upsell signal, cited by id from the facts. A request already covered by warranty, maintenance or the approved scope is NOT an opportunity.',
  'Describe the need in facts only: what the client asked for and why. Never write a price, an amount, a quote or a discount, never a deadline, and never invent a problem, urgency or pressure.',
  'You record the opportunity as detected only; a person qualifies it and hands it to Sales. If the account is at risk or critical, still describe the need honestly: the system holds outreach until recovery.',
  'Never write a secret.',
].join(' ');

export function renderOpportunityFacts(f: OpportunityFacts): string {
  return [
    `Project: ${f.projectName}. Derived health: ${f.healthStatus ?? 'unknown'}.`,
    `Tickets a person classified as out of scope: ${f.tickets.length === 0 ? 'none' : f.tickets.map((t) => `${t.id} [${t.classification ?? 'unclassified'}] ${t.title}${t.description ? ` - ${t.description}` : ''}`).join('; ')}`,
    `Completed check-ins: ${f.checkIns.length === 0 ? 'none' : f.checkIns.map((c) => `${c.id} ${c.kind}: ${c.outcome ?? 'no outcome'}`).join('; ')}`,
    `Upsell signals: ${f.signals.length === 0 ? 'none' : f.signals.map((s) => `${s.id} ${s.kind}`).join('; ')}`,
  ].join('\n');
}

export function opportunityJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['opportunity', 'reason'],
    properties: {
      opportunity: {
        type: ['object', 'null'],
        description: 'null when there is no legitimate opportunity.',
        additionalProperties: false,
        required: ['kind', 'need', 'requestedOutcome', 'urgency', 'stakeholders', 'constraints', 'evidence'],
        properties: {
          kind: { type: 'string', enum: [...OPPORTUNITY_KINDS] },
          need: { type: 'string', description: 'The client need in facts, 10 to 1200 characters. No price.' },
          requestedOutcome: { type: ['string', 'null'] },
          urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
          stakeholders: { type: ['string', 'null'] },
          constraints: { type: ['string', 'null'] },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: { type: 'string', enum: [...EVIDENCE_TYPES] }, id: { type: 'string' } } },
          },
        },
      },
      reason: { type: 'string', description: 'Why there is or is not an opportunity, at most 600 characters.' },
    },
  };
}
