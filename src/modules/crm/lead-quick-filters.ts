/**
 * The Leads list's two quick filters — owner decision 14 (2026-10-03).
 *
 * Both are read from what is stored, never from a score: the newest INBOUND
 * message (author_type 'client' on any of the lead's conversations) and the
 * lead's stage.
 *
 *   HOT LEADS    stage Qualified or beyond AND the lead replied in the last
 *                7 days.
 *   NO RESPONSE  3 or more days of silence.
 *
 * "Stage" is the lead's status plus its deal: `qualified` and `converted` are
 * Qualified-or-beyond, and so is any lead whose deal has reached proposal,
 * negotiation or won (a deal at a later stage means it was qualified first,
 * whatever the status column still says). `new`, `qualifying`, `nurture` and
 * `disqualified` are not — a parked or refused lead is not "hot".
 *
 * THE HONEST READING OF "NO RESPONSE". "Silence" is measured from the lead's
 * last inbound message or, when the lead has never written, from the day it
 * was created — the clock starts when we could first have heard from them. It
 * applies to leads still being worked (`new`, `qualifying`, `qualified`); a
 * converted or disqualified lead is finished, and a nurture lead is parked on
 * purpose and silent by design, so neither is "no response". Three days means
 * three full days of elapsed time (72 hours), not three calendar boundaries.
 * A lead who wrote 2 days 23 hours ago is not silent yet.
 */

export const HOT_REPLY_WINDOW_DAYS = 7;
export const NO_RESPONSE_AFTER_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export const QUICK_FILTER_KEYS = ['hot_leads', 'no_response'] as const;
export type QuickFilterKey = (typeof QUICK_FILTER_KEYS)[number];

export function isQuickFilterKey(value: string | undefined): value is QuickFilterKey {
  return (QUICK_FILTER_KEYS as readonly string[]).includes(value ?? '');
}

export type LeadHeat = {
  /** `crm.leads.status`. */
  status: string;
  /** The lead's deal stage when it has one (`sales.opportunities.stage`). */
  dealStage?: string | null;
  createdAt: string;
  /** Newest inbound message, ISO; null when the lead has never written. */
  lastInboundAt: string | null;
};

const QUALIFIED_OR_BEYOND_STATUS = new Set(['qualified', 'converted']);
const DEAL_STAGES_PAST_QUALIFIED = new Set(['proposal', 'negotiation', 'won']);
const STILL_BEING_WORKED = new Set(['new', 'qualifying', 'qualified']);

export function isQualifiedOrBeyond(lead: Pick<LeadHeat, 'status' | 'dealStage'>): boolean {
  return QUALIFIED_OR_BEYOND_STATUS.has(lead.status) || DEAL_STAGES_PAST_QUALIFIED.has(lead.dealStage ?? '');
}

export function isHotLead(lead: LeadHeat, now: Date): boolean {
  if (!isQualifiedOrBeyond(lead) || lead.lastInboundAt === null) return false;
  const since = now.getTime() - new Date(lead.lastInboundAt).getTime();
  // A message "from the future" (clock skew) is a reply just now, not a reason to hide the lead.
  return since <= HOT_REPLY_WINDOW_DAYS * DAY_MS;
}

/** The moment silence is measured from: the last inbound message, else creation. */
export function silentSince(lead: Pick<LeadHeat, 'createdAt' | 'lastInboundAt'>): string {
  return lead.lastInboundAt ?? lead.createdAt;
}

export function hasNoResponse(lead: LeadHeat, now: Date): boolean {
  if (!STILL_BEING_WORKED.has(lead.status)) return false;
  const quiet = now.getTime() - new Date(silentSince(lead)).getTime();
  return quiet >= NO_RESPONSE_AFTER_DAYS * DAY_MS;
}

export function matchesQuickFilter(key: QuickFilterKey, lead: LeadHeat, now: Date): boolean {
  return key === 'hot_leads' ? isHotLead(lead, now) : hasNoResponse(lead, now);
}
