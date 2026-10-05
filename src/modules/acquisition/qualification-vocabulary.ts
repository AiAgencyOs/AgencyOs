/** Client-safe words for qualification. The arithmetic and the rules live in `crm.qualify_prospect`; these are labels. */
export const QUALIFICATION_FACTORS = [
  'need_clarity', 'service_fit', 'budget_fit', 'timeline_fit', 'decision_maker', 'feasibility',
  'urgency', 'engagement', 'response_quality', 'trust_readiness', 'commercial_potential',
] as const;
export type QualificationFactor = (typeof QUALIFICATION_FACTORS)[number];

export const FACTOR_LABEL: Record<QualificationFactor, string> = {
  need_clarity: 'Clarity of the need',
  service_fit: 'Fit with a service we offer',
  budget_fit: 'Budget fit',
  timeline_fit: 'Timeline fit',
  decision_maker: 'Decision-maker involved',
  feasibility: 'Project feasibility',
  urgency: 'Urgency',
  engagement: 'Engagement',
  response_quality: 'Quality of their responses',
  trust_readiness: 'Trust and readiness',
  commercial_potential: 'Commercial potential',
};

export const FUNNEL_STAGES = ['discovered', 'qualified', 'contacted', 'replied', 'meeting_requested', 'meeting_held', 'quote_requested', 'won', 'lost', 'opted_out'] as const;
export const FUNNEL_LABEL: Record<(typeof FUNNEL_STAGES)[number], string> = {
  discovered: 'People on the list',
  qualified: 'Qualified',
  contacted: 'Contacted',
  replied: 'Replied',
  meeting_requested: 'Meeting asked for',
  meeting_held: 'Meeting held',
  quote_requested: 'Quotation asked for',
  won: 'Won',
  lost: 'Lost',
  opted_out: 'Opted out',
};

/** The disqualifier codes a person may see, in words. */
export function disqualifierWords(code: string): string {
  if (code.startsWith('icp_exclusion:')) return `On the exclusion list (${code.slice('icp_exclusion:'.length)})`;
  const words: Record<string, string> = {
    suppressed: 'Asked never to be emailed',
    do_not_contact: 'Marked do not contact',
    blocked: 'On the block list',
    outside_target_geography: 'Outside the target countries',
    outside_target_industry: 'Outside the target industries',
    service_not_targeted: 'A service we are not targeting now',
    below_threshold: 'Below the minimum score',
  };
  return words[code] ?? code;
}
