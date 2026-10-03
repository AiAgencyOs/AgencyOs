import { z } from 'zod';

import { decoderSafeSchema } from '@/lib/ai/schema';
import { LOST_CATEGORIES } from './schema';

/**
 * Reading a client's message for a clear "no" or a clear "not yet".
 *
 * The first live run left an explicit rejection ("I don't want to proceed, we
 * went with another agency") sitting as a live lead with an active follow-up,
 * and a client who said "December mein baat karte hain" only stopped being
 * chased once a person set a date. The owner decided (2026-10-03): the agent
 * marks the CLEAR cases itself, and says so; anything it is not sure of it
 * proposes to staff and leaves alone.
 *
 * What makes that safe is not the model's judgment but the rules below, which
 * are code and are tested:
 *   • a decline that comes with a condition ("...unless you cut 50%") is
 *     negotiation, not a loss — never marked;
 *   • the quoted words must appear VERBATIM in the client's message, or the
 *     reading is discarded (a model that cannot quote the sentence did not
 *     read one);
 *   • "not yet" becomes NURTURE only with a return date the client's own words
 *     support (a number of days), and in a sane range;
 *   • nothing is ever WON by this path, and a lead that is already closed,
 *     converted, or has an accepted quotation is never touched.
 */
/**
 * Doc 09 §26's four reasons for nurture. Restated here, not imported: the sales
 * module may not reach into the CRM module's schema (ARCHITECTURE.md §3.2). A
 * test holds this list equal to `NURTURE_REASONS`, so they cannot drift apart.
 */
export const OUTCOME_NURTURE_REASONS = [
  'not_ready_now',
  'budget_later',
  'waiting_for_decision_maker',
  'needs_more_evidence',
] as const;

export const leadOutcomeReadingSchema = z
  .object({
    outcome: z.enum(['none', 'declined', 'postponed']),
    certainty: z.enum(['clear', 'unclear']),
    /** True when the client attaches a condition to the no — a discount, a feature, a guarantee. */
    conditional: z.boolean(),
    /** The client's own words, copied exactly from the message; empty when outcome is none. */
    quote: z.string().max(300),
    lostCategory: z.enum(LOST_CATEGORIES).nullable(),
    nurtureReason: z.enum(OUTCOME_NURTURE_REASONS).nullable(),
    /** For postponed: how many days from today the client's words put the return — null if they gave no timeframe. */
    returnInDays: z.number().int().min(0).max(1000).nullable(),
  })
  .strict();

export type LeadOutcomeReading = z.infer<typeof leadOutcomeReadingSchema>;

export function leadOutcomeJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(leadOutcomeReadingSchema)) as Record<string, unknown>;
}

export const LEAD_OUTCOME_PROMPT = [
  'You read ONE message from a client of a software agency and answer one question: have they just',
  'said, in this message, that they will NOT go ahead, or that they will go ahead but NOT NOW?',

  'outcome "declined" — they say they are not proceeding / have chosen someone else / cancelled / no budget.',
  'outcome "postponed" — they say they still want it but later (a month, a quarter, after funding).',
  'outcome "none" — anything else, including: still negotiating, asking a question, going quiet, being unsure,',
  'asking for a lower price, saying a price is high, comparing agencies, or "let me think". When in doubt: none.',

  'conditional = true when the no comes with a condition under which they WOULD proceed ("50% kam karo, warna',
  'nahi", "only if you guarantee the date"). That is a negotiation, not a loss.',

  'certainty "clear" only when a reasonable salesperson reading this message alone would call it settled.',
  'Otherwise "unclear".',

  'quote — copy the exact words of theirs that show it, character for character, from the message. If you',
  'cannot quote it, the outcome is none.',

  'lostCategory (declined only): price_too_high, no_budget, chose_competitor, project_postponed,',
  'not_a_fit, requirements_changed, trust_not_established, timeline_mismatch, client_cancelled, other.',
  'Pick the reason THEY gave; "other" if they gave none.',

  'nurtureReason (postponed only): not_ready_now, budget_later (money/funding is the reason),',
  'waiting_for_decision_maker, needs_more_evidence.',
  'returnInDays (postponed only): how many days from TODAY their words put the return — "2 mahine baad" is 60,',
  '"next quarter" is null because the date is not theirs to read, "December" is days until the 1st of December',
  'from today\'s date given below. Null when they gave no timeframe. Never guess a timeframe.',

  'You are not deciding anything. You do not answer the client, offer a discount, or suggest a next step.',
].join(' ');

export type OutcomeAct =
  | { act: 'none'; why: string }
  | { act: 'suggest'; why: string; reading: LeadOutcomeReading }
  | { act: 'disqualify_lead'; category: (typeof LOST_CATEGORIES)[number]; quote: string }
  | { act: 'lose_deal'; category: (typeof LOST_CATEGORIES)[number]; quote: string }
  | { act: 'nurture'; reason: (typeof OUTCOME_NURTURE_REASONS)[number]; days: number; quote: string };

const MIN_RETURN_DAYS = 7;
const MAX_RETURN_DAYS = 365;
/** Statuses this path may move a lead out of. Everything else is left exactly as it is. */
const ACTIONABLE = new Set(['new', 'qualifying', 'qualified']);

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The decision: what to DO with a reading, given the facts about the lead. Pure. */
export function decideOutcome(
  reading: LeadOutcomeReading,
  facts: {
    messageBody: string;
    leadStatus: string;
    /** An open (not won, not lost) deal exists for the lead. */
    hasOpenDeal: boolean;
    /** A quotation the client accepted exists — the deal is being won, not lost. */
    hasAcceptedQuotation: boolean;
  },
): OutcomeAct {
  if (reading.outcome === 'none') return { act: 'none', why: 'the message does not decline or postpone' };
  if (reading.conditional) return { act: 'none', why: 'a no with a condition is a negotiation, not a loss' };

  // The words must be the client's. A model that "reads" a rejection it cannot
  // quote has not read one.
  const quote = reading.quote.trim();
  if (quote === '' || !squash(facts.messageBody).includes(squash(quote))) {
    return { act: 'none', why: 'the quoted words are not in the message' };
  }

  if (!ACTIONABLE.has(facts.leadStatus) && !(facts.leadStatus === 'nurture' && reading.outcome === 'declined')) {
    return { act: 'none', why: `the lead is already ${facts.leadStatus}` };
  }
  if (facts.hasAcceptedQuotation) return { act: 'none', why: 'the client has accepted a quotation' };

  if (reading.certainty !== 'clear') return { act: 'suggest', why: 'the reading is not certain', reading };

  if (reading.outcome === 'declined') {
    const category = reading.lostCategory ?? 'other';
    return facts.hasOpenDeal ? { act: 'lose_deal', category, quote } : { act: 'disqualify_lead', category, quote };
  }

  // postponed
  if (facts.leadStatus === 'nurture') return { act: 'none', why: 'the lead is already in nurture' };
  const days = reading.returnInDays;
  if (reading.nurtureReason === null || days === null || days < MIN_RETURN_DAYS || days > MAX_RETURN_DAYS) {
    return { act: 'suggest', why: 'no usable return date in the client\'s words', reading };
  }
  return { act: 'nurture', reason: reading.nurtureReason, days, quote };
}
