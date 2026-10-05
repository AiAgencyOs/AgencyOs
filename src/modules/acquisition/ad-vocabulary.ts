/** Client-safe words for the Meta and Google tabs. The rules live in the `crm.*` doors; these are labels. */
export const AD_PLATFORMS = ['meta_ads', 'google_ads'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];
export const AD_PLATFORM_LABEL: Record<AdPlatform, string> = { meta_ads: 'Meta (Facebook / Instagram)', google_ads: 'Google Ads' };

export const CHANGE_KINDS = ['launch', 'budget_increase', 'budget_decrease', 'targeting_change', 'creative_change'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const CHANGE_LABEL: Record<ChangeKind, string> = {
  launch: 'Launch', budget_increase: 'Budget increase', budget_decrease: 'Budget decrease', targeting_change: 'Targeting change', creative_change: 'Creative change',
};

/** Which governed action a kind of change is approved under. Mirrors `crm._ad_action`. */
export function adActionFor(kind: ChangeKind): 'ad_launch' | 'ad_budget_increase' | 'ad_targeting_change' {
  return kind === 'budget_increase' ? 'ad_budget_increase' : kind === 'targeting_change' ? 'ad_targeting_change' : 'ad_launch';
}

export const VERSION_STATE_WORDS: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger'; meaning: string }> = {
  DRAFT: { label: 'Draft', tone: 'neutral', meaning: 'Written, not yet checked.' },
  CHECKED: { label: 'Checks passed', tone: 'info', meaning: 'No rule-breaking found. This is not approval - submit it for a person to decide.' },
  CHECK_FAILED: { label: 'Checks failed', tone: 'danger', meaning: 'It breaks a rule. Write the next version.' },
  ADMIN_REVIEW: { label: 'Waiting for approval', tone: 'warning', meaning: 'An admin must approve exactly this plan and budget.' },
  REJECTED: { label: 'Rejected', tone: 'danger', meaning: 'Not approved, or the approval ran out.' },
  LAUNCHING: { label: 'Applying', tone: 'warning', meaning: 'Being sent to the platform, or its outcome is being confirmed.' },
  LIVE: { label: 'Live', tone: 'success', meaning: 'Running as approved.' },
  PAUSED: { label: 'Paused', tone: 'warning', meaning: 'The platform confirmed it is paused.' },
  ENDED: { label: 'Ended', tone: 'neutral', meaning: 'Finished.' },
  SUPERSEDED: { label: 'Replaced', tone: 'neutral', meaning: 'A newer version took its place.' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', meaning: 'Withdrawn.' },
};

export const HEALTH_WORDS: Record<string, string> = {
  zero_delivery: 'Not delivering', budget_overrun: 'Over its daily budget', spend_spike: 'Spend spike', cpl_spike: 'Cost per lead spike',
  possible_tracking_failure: 'Clicks or leads not reaching the CRM', low_quality_leads: 'Leads, but none qualify', ads_rejected: 'Ads rejected by the platform', platform_limited: 'Account limited by the platform',
};

export const RECOMMENDATION_WORDS: Record<string, string> = {
  no_spend_yet: 'No spend yet.',
  not_enough_leads_to_judge: 'Not enough leads yet to judge it. Wait.',
  review_for_pause_no_qualified_leads: 'Leads but none qualified: consider pausing or changing the audience.',
  review_for_budget_increase_request: 'It has won work: consider requesting a budget increase (needs approval).',
  keep_watching: 'Keep watching.',
};

/** The problem codes a person may see, in words. */
export function planProblemWords(code: string): string {
  if (code.startsWith('manufactured_urgency:')) return `Pressure language ("${code.slice('manufactured_urgency:'.length)}")`;
  if (code.startsWith('unsupported_claim:')) return `A claim with no proof ("${code.slice('unsupported_claim:'.length)}")`;
  const words: Record<string, string> = {
    plan_is_not_an_object: 'The plan is not in the expected shape',
    unverified_statistic: 'A percentage with no source',
    meta_must_route_to_whatsapp: 'A Meta ad must send people to WhatsApp',
    needs_an_ad_set: 'It needs at least one ad set', ad_set_needs_locations: 'An ad set needs locations', age_min_below_18: 'Targeting must not include under-18s',
    needs_a_creative: 'It needs at least one creative', headline_length: 'A headline must be 1 to 40 characters', primary_text_length: 'The primary text must be 20 to 500 characters',
    cta_must_open_whatsapp: 'The call to action must open WhatsApp',
    google_needs_a_landing_page: 'A Google ad must point at a landing page version', needs_an_ad_group: 'It needs at least one ad group',
    ad_group_needs_three_or_more_keywords: 'An ad group needs three or more keywords', keyword_shape: 'A keyword needs text and a match type',
    needs_a_negative_keyword_strategy: 'It needs negative keywords', needs_an_ad: 'It needs at least one ad',
    headline_count: 'An ad needs 3 to 15 headlines', headline_over_30_characters: 'A headline is over 30 characters',
    description_count: 'An ad needs 2 to 4 descriptions', description_over_90_characters: 'A description is over 90 characters',
  };
  return words[code] ?? code;
}
