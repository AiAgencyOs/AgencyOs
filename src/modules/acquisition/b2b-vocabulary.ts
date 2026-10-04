/** Client-safe words for the B2B tab. The rules live in the `crm.*` doors; these are labels. */
export const B2B_PLATFORMS = ['upwork', 'freelancer', 'peopleperhour', 'guru', 'contra', 'fiverr', 'clutch', 'goodfirms'] as const;
export type B2bPlatform = (typeof B2B_PLATFORMS)[number];
export const B2B_PLATFORM_LABEL: Record<B2bPlatform, string> = {
  upwork: 'Upwork', freelancer: 'Freelancer', peopleperhour: 'PeoplePerHour', guru: 'Guru', contra: 'Contra', fiverr: 'Fiverr', clutch: 'Clutch', goodfirms: 'GoodFirms',
};

export const OFFPLATFORM_LABEL = { forbidden: 'Never off the platform', after_award: 'Only after an award', allowed: 'Allowed' } as const;
export const OFFPLATFORM_ORDER = ['forbidden', 'after_award', 'allowed'] as const;
export const AUTOMATION_LABEL = { manual: 'A person does everything on the platform', assisted: 'AgencyOS prepares, a person sends', automated: 'AgencyOS may send' } as const;
export const AUTOMATION_ORDER = ['manual', 'assisted', 'automated'] as const;

export const OPPORTUNITY_WORDS: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' }> = {
  new: { label: 'New', tone: 'neutral' }, scored: { label: 'Worth a look', tone: 'info' }, below_threshold: { label: 'Below your threshold', tone: 'warning' },
  excluded: { label: 'Excluded by your terms', tone: 'danger' }, shortlisted: { label: 'Shortlisted', tone: 'info' }, skipped: { label: 'Skipped', tone: 'neutral' },
  submitted: { label: 'Proposal sent', tone: 'warning' }, won: { label: 'Won', tone: 'success' }, lost: { label: 'Lost', tone: 'neutral' },
};

export const PROPOSAL_STATE_WORDS: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger'; meaning: string }> = {
  DRAFT: { label: 'Draft', tone: 'neutral', meaning: 'Written, not yet checked.' },
  CHECKED: { label: 'Checks passed', tone: 'info', meaning: 'No rule-breaking found. This is not approval - submit it for an admin.' },
  CHECK_FAILED: { label: 'Checks failed', tone: 'danger', meaning: 'It breaks a rule. Write the next version.' },
  ADMIN_REVIEW: { label: 'Waiting for approval', tone: 'warning', meaning: 'An admin must approve exactly these words and this price. Once approved, send it on the platform yourself and record it here.' },
  REJECTED: { label: 'Rejected', tone: 'danger', meaning: 'Not approved, or the approval ran out.' },
  SUBMITTING: { label: 'Sending', tone: 'warning', meaning: 'Being sent, or its outcome is being confirmed.' },
  SUBMITTED: { label: 'Sent', tone: 'success', meaning: 'Recorded as sent, once.' },
  SUPERSEDED: { label: 'Replaced', tone: 'neutral', meaning: 'A newer version took its place.' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', meaning: 'Withdrawn.' },
  APPLIED: { label: 'Applied', tone: 'success', meaning: 'Changed on the platform, with evidence.' },
};

export function fitReasonWords(code: string): string {
  if (code.startsWith('service_match:')) return `Matches your service "${code.slice('service_match:'.length)}"`;
  if (code.startsWith('excluded_term:')) return `Mentions "${code.slice('excluded_term:'.length)}", which you excluded`;
  const words: Record<string, string> = {
    no_target_service_mentioned: 'Names none of your target services', budget_ok: 'Budget meets your minimum', budget_not_stated: 'No budget stated',
    budget_below_minimum: 'Budget is below your minimum', enough_detail: 'Detailed enough to judge', thin_description: 'Too little detail to judge',
  };
  return words[code] ?? code;
}

/** The problem codes a person may see, in words (proposals and profiles). */
export function b2bProblemWords(code: string): string {
  if (code.startsWith('manufactured_urgency:')) return `Pressure language ("${code.slice('manufactured_urgency:'.length)}")`;
  if (code.startsWith('unsupported_claim:')) return `A claim with no proof ("${code.slice('unsupported_claim:'.length)}")`;
  const words: Record<string, string> = {
    contains_an_email_address: 'Contains an email address - this marketplace does not allow contact off the platform',
    contains_a_phone_number: 'Contains a phone number - this marketplace does not allow contact off the platform',
    names_a_messaging_app: 'Names a messaging app - this marketplace does not allow contact off the platform',
    contains_an_external_link: 'Contains a link to somewhere else - this marketplace does not allow it',
    unverified_statistic: 'A percentage with no source', too_short_to_be_a_proposal: 'Too short to be a proposal (80 characters at least)',
    needs_a_price_from_a_person: 'A person must set the price - a draft written by an agent has none', needs_a_timeline: 'It needs a timeline',
    past_work_is_not_a_portfolio_item: 'Past work must be one of the agency\'s own active portfolio items', over_the_monthly_connects_budget: 'It would go over this month\'s connects budget',
    content_is_not_an_object: 'The profile is not in the expected shape', headline_length: 'The headline must be 5 to 120 characters', summary_length: 'The summary must be 50 to 3,000 characters',
    claims_a_platform_could_not_confirm: 'Testimonials, reviews, ratings and badges cannot be written here - the platform is the only source for them',
  };
  return words[code] ?? code;
}

export const RECORD_REFUSAL_WORDS: Record<string, string> = {
  not_covered: 'It has not been approved as exactly this version.', blocked: 'It is blocked right now.', already_submitted: 'It was already recorded as sent.',
  needs_reference: 'Enter the platform\'s own reference for the proposal.', not_approved_state: 'It is not waiting for approval any more.',
  monthly_connects_exceeded: 'It would go over this month\'s connects budget.', daily_limit: 'The daily limit for this channel has been reached.', channel_paused: 'The B2B channel is paused.', acquisition_paused: 'All lead generation is paused.',
  state_pending: 'The approval has not been decided yet.',
};
