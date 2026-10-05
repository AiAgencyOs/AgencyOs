/** Client-safe words for the policy screen. The rules themselves live in `crm.acquisition_decide`; these are labels. */
export const ACTION_TYPES = [
  'email_outreach', 'email_followup', 'social_publish', 'social_outreach', 'social_followup', 'b2b_proposal_submit', 'b2b_outreach',
  'ad_launch', 'ad_budget_increase', 'ad_targeting_change', 'landing_page_deploy', 'profile_update', 'discount', 'special_offer',
  'payment_terms', 'high_volume_messaging',
] as const;

export const NEVER_AUTO_ACTIONS: readonly (typeof ACTION_TYPES)[number][] = ['social_publish', 'b2b_proposal_submit', 'ad_launch', 'landing_page_deploy', 'profile_update', 'ad_budget_increase', 'ad_targeting_change'];

export const ACTION_LABEL: Record<(typeof ACTION_TYPES)[number], string> = {
  email_outreach: 'Send an outreach email',
  email_followup: 'Send an email follow-up',
  social_publish: 'Publish a social post',
  social_outreach: 'Message a prospect on social',
  social_followup: 'Follow up on social',
  b2b_proposal_submit: 'Submit a marketplace proposal',
  b2b_outreach: 'Message a marketplace buyer',
  ad_launch: 'Launch an ad campaign',
  ad_budget_increase: 'Raise an ad budget',
  ad_targeting_change: 'Change ad targeting',
  landing_page_deploy: 'Deploy a landing page',
  profile_update: 'Change a directory or marketplace profile',
  discount: 'Offer a discount',
  special_offer: 'Make a special offer',
  payment_terms: 'Change payment terms',
  high_volume_messaging: 'Send a high-volume batch',
};
