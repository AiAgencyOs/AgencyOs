/** Client-safe words for the landing page section of the Google tab. The rules live in the `crm.*` doors; these are labels. */
export const LANDING_STATE_WORDS: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger'; meaning: string }> = {
  DRAFT: { label: 'Draft', tone: 'neutral', meaning: 'Written, not yet checked.' },
  CHECKED: { label: 'Checks passed', tone: 'info', meaning: 'No rule-breaking found. This is not approval - submit it for an admin.' },
  CHECK_FAILED: { label: 'Checks failed', tone: 'danger', meaning: 'It breaks a rule. Write the next version.' },
  ADMIN_REVIEW: { label: 'Waiting for approval', tone: 'warning', meaning: 'An admin must approve exactly this page, address and WhatsApp number.' },
  REJECTED: { label: 'Rejected', tone: 'danger', meaning: 'Not approved, or the approval ran out.' },
  DEPLOYING: { label: 'Deploying', tone: 'warning', meaning: 'Being sent to the host, or its outcome is being confirmed.' },
  DEPLOYED: { label: 'Deployed, not yet verified', tone: 'warning', meaning: 'Sent to the host. It is not usable by an ad until the public address has been checked.' },
  VERIFIED: { label: 'Verified', tone: 'success', meaning: 'The public address was fetched and carries exactly the approved page.' },
  VERIFY_FAILED: { label: 'Verification failed', tone: 'danger', meaning: 'The public address does not match what was approved. Ads cannot launch to it.' },
  SUPERSEDED: { label: 'Replaced', tone: 'neutral', meaning: 'A newer version took its place.' },
  RETIRED: { label: 'Retired', tone: 'neutral', meaning: 'Taken out of use.' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', meaning: 'Withdrawn.' },
};

export const VERIFICATION_CHECK_LABEL: Record<string, string> = {
  reachable: 'The address answers',
  carries_approved_version: 'It carries the approved version',
  links_to_approved_whatsapp: 'Its only WhatsApp link is the approved number',
  captures_tracking: 'It records which ad the visit came from',
};

export function landingProblemWords(code: string): string {
  if (code.startsWith('manufactured_urgency:')) return `Pressure language ("${code.slice('manufactured_urgency:'.length)}")`;
  if (code.startsWith('unsupported_claim:')) return `A claim with no proof ("${code.slice('unsupported_claim:'.length)}")`;
  const words: Record<string, string> = {
    content_is_not_an_object: 'The page is not in the expected shape',
    headline_length: 'The headline must be 5 to 90 characters', subheadline_too_long: 'The subheadline is over 200 characters', cta_text_length: 'The button text must be 3 to 40 characters',
    needs_a_privacy_link: 'It needs a privacy link (https)', needs_a_contact_email: 'It needs a contact email',
    benefits_count: 'It needs three to six benefits', benefit_length: 'A benefit title or text is the wrong length',
    too_many_faq: 'More than eight questions', faq_length: 'A question or answer is the wrong length',
    proof_without_a_source: 'Proof must point at one of the agency\'s own portfolio items', proof_caption_length: 'A proof caption must be 5 to 200 characters',
    proof_is_not_a_portfolio_item: 'Proof points at something that is not an active portfolio item of this agency',
    testimonials_are_not_supported: 'Testimonials, reviews and logos are not supported - they cannot be traced to a source',
    unverified_statistic: 'A percentage with no source',
  };
  return words[code] ?? code;
}
