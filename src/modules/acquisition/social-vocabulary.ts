/** Client-safe words for the Social tab. The rules live in the `crm.*` doors; these are labels. */
export const SOCIAL_PLATFORMS = ['linkedin', 'instagram', 'facebook'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const PLATFORM_LABEL: Record<SocialPlatform, string> = { linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook' };

export const CONTENT_OBJECTIVES = ['authority', 'reach', 'engagement', 'education', 'portfolio_proof', 'lead_generation'] as const;
export const OBJECTIVE_LABEL: Record<(typeof CONTENT_OBJECTIVES)[number], string> = {
  authority: 'Authority', reach: 'Reach', engagement: 'Engagement', education: 'Education', portfolio_proof: 'Portfolio proof', lead_generation: 'Lead generation',
};

export const CONTENT_FORMATS = ['text', 'image', 'carousel', 'infographic', 'video', 'case_study', 'portfolio'] as const;
export const FORMAT_LABEL: Record<(typeof CONTENT_FORMATS)[number], string> = {
  text: 'Text', image: 'Image', carousel: 'Carousel', infographic: 'Infographic', video: 'Video', case_study: 'Case study', portfolio: 'Portfolio piece',
};

/** The specification's labels for a version, as derived by `crm.content_status`. */
export const STATUS_WORDS: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger'; meaning: string }> = {
  DRAFT: { label: 'Draft', tone: 'neutral', meaning: 'Written, not yet reviewed.' },
  AI_REVIEW_PASSED: { label: 'AI review passed', tone: 'info', meaning: 'The automated checks passed. This is not approval - a person has not seen it yet.' },
  AI_REVIEW_FAILED: { label: 'AI review failed', tone: 'danger', meaning: 'It broke a rule. Write the next version.' },
  ADMIN_REVIEW: { label: 'Waiting for approval', tone: 'warning', meaning: 'An admin must approve exactly these words.' },
  APPROVED: { label: 'Approved', tone: 'success', meaning: 'Approved as exactly this content. Schedule it to publish.' },
  APPROVAL_LAPSED: { label: 'Approval expired', tone: 'warning', meaning: 'The approval ran out. Submit it again.' },
  APPROVAL_EXPIRED: { label: 'Approval expired', tone: 'warning', meaning: 'Nobody decided in time. Submit it again.' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'warning', meaning: 'The admin asked for changes. Write the next version.' },
  REJECTED: { label: 'Rejected', tone: 'danger', meaning: 'Not approved.' },
  SCHEDULED: { label: 'Scheduled', tone: 'info', meaning: 'Approved and waiting for its time.' },
  PUBLISHING: { label: 'Publishing', tone: 'warning', meaning: 'Being posted now, or its outcome is being confirmed with the platform.' },
  PUBLISHED: { label: 'Published', tone: 'success', meaning: 'Posted once.' },
  SUPERSEDED: { label: 'Replaced', tone: 'neutral', meaning: 'A newer version took its place. Its approval no longer applies.' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', meaning: 'Withdrawn.' },
};

/** The review codes a person may see, in words. */
export function reviewWords(code: string): string {
  if (code.startsWith('manufactured_urgency:')) return `Pressure language ("${code.slice('manufactured_urgency:'.length)}")`;
  if (code.startsWith('unsupported_claim:')) return `A claim with no proof ("${code.slice('unsupported_claim:'.length)}")`;
  if (code.startsWith('copies_reference:')) return 'Reproduces ten or more words of a reference';
  const words: Record<string, string> = {
    too_long_for_platform: 'Too long for the platform',
    missing_cta: 'A lead-generation post needs a call to action',
    missing_asset: 'This format needs an image or video',
    carousel_needs_two_or_more_slides: 'A carousel needs at least two slides',
    unverified_statistic: 'A percentage with no source',
    duplicate_of_recent_post: 'Repeats a post from the last 30 days',
    does_not_mention_the_target_service: 'Does not mention the service it targets',
    insecure_link: 'Contains a non-https link',
    no_hashtags: 'No hashtags',
  };
  return words[code] ?? code;
}
