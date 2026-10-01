import { HOT_REPLY_WINDOW_DAYS, isHotLead, isQualifiedOrBeyond, type LeadHeat } from './lead-quick-filters';

/**
 * The Hot / Warm / Cold label — owner decision 1, round 2 (2026-10-01), ADM-88.
 *
 * A label, never a number. It is derived on the spot from three recorded
 * reasons and says which of them it used:
 *
 *   stage         Qualified or beyond (the lead's status, or a deal at proposal,
 *                 negotiation or won — `isQualifiedOrBeyond`)
 *   recent reply  the lead wrote to us within the last 7 days
 *                 (`HOT_REPLY_WINDOW_DAYS`, the same window the Hot Leads
 *                 quick filter uses)
 *   budget        a budget is recorded on the lead
 *
 *   HOT   stage Qualified or beyond AND a reply in the last 7 days — exactly
 *         the Hot Leads quick filter, so the label and the filter never disagree.
 *   WARM  not hot, and at least one of the three reasons holds.
 *   COLD  no reason holds, or the lead is disqualified (a refused lead is not
 *         warm whatever it once said), or parked in nurture with no reply.
 *
 * The stored `crm.leads.score` column is left untouched and is never read here
 * or shown anywhere.
 */

export type LeadHeatLabel = 'Hot' | 'Warm' | 'Cold';

export type LeadHeatInput = LeadHeat & {
  /** True when a budget is recorded on the lead. */
  budgetRecorded: boolean;
};

export type LeadHeatReading = {
  label: LeadHeatLabel;
  /** One sentence per reason, positive and negative, in a fixed order. */
  reasons: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_WORD: Record<string, string> = {
  new: 'New',
  qualifying: 'Qualifying',
  qualified: 'Qualified',
  converted: 'Converted',
  nurture: 'Nurture',
  disqualified: 'Disqualified',
};

function ago(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS);
  if (days <= 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function deriveLeadHeat(lead: LeadHeatInput, now: Date): LeadHeatReading {
  const stageOk = isQualifiedOrBeyond(lead);
  const lastInbound = lead.lastInboundAt === null ? null : now.getTime() - new Date(lead.lastInboundAt).getTime();
  const recentReply = lastInbound !== null && lastInbound <= HOT_REPLY_WINDOW_DAYS * DAY_MS;

  const reasons = [
    stageOk
      ? `Stage: ${STATUS_WORD[lead.status] ?? lead.status}${lead.dealStage ? `, deal at ${lead.dealStage}` : ''} (Qualified or beyond)`
      : `Stage: ${STATUS_WORD[lead.status] ?? lead.status} (not yet Qualified)`,
    recentReply
      ? `Replied ${ago(lead.lastInboundAt as string, now)} (within ${HOT_REPLY_WINDOW_DAYS} days)`
      : lead.lastInboundAt === null
        ? 'Has never replied'
        : `Last reply ${ago(lead.lastInboundAt, now)} (more than ${HOT_REPLY_WINDOW_DAYS} days)`,
    lead.budgetRecorded ? 'Budget recorded' : 'No budget recorded',
  ];

  if (isHotLead(lead, now)) return { label: 'Hot', reasons };
  if (lead.status === 'disqualified') return { label: 'Cold', reasons: [...reasons, 'Disqualified leads are always Cold'] };
  if (stageOk || recentReply || lead.budgetRecorded) return { label: 'Warm', reasons };
  return { label: 'Cold', reasons };
}

/** The hover text: the label and its reasons, one per line. */
export function heatTitle(reading: LeadHeatReading): string {
  return [`${reading.label} lead`, ...reading.reasons].join('\n');
}

const RANK: Record<LeadHeatLabel, number> = { Cold: 0, Warm: 1, Hot: 2 };

/** For the sortable column: Hot above Warm above Cold when sorted high-first. */
export function heatRank(label: LeadHeatLabel): number {
  return RANK[label];
}
