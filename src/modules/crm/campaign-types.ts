/**
 * The words a campaign is described in — SCR-059, owner decision 2026-09-30
 * (broadcast reopened as a governed campaign). No `server-only` import: the
 * list page, the detail page and their client forms all read these.
 */

export const CAMPAIGN_STATUSES = ['draft', 'approved', 'running', 'done', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_RECIPIENT_STATUSES = ['pending', 'sent', 'refused', 'failed'] as const;
export type CampaignRecipientStatus = (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

/**
 * Why a recipient did not get the message — a CLOSED set.
 *
 * Every refusal the chokepoint can hand back has a name here, so the
 * per-recipient table reads the same way for every campaign and a test can
 * assert nothing invents a fourth kind of "no". The provider's own words
 * after a failed delivery are recorded on the row as `failed`, not here.
 */
export const CAMPAIGN_REFUSAL_REASONS = [
  /** The lead has no WhatsApp thread of its own to write on. */
  'no_conversation',
  /** `crm.send_outbound_message` found no recorded consent. */
  'no_consent',
  /** The thread no longer exists. */
  'thread_not_found',
  /** The contact has no phone number to send to. */
  'no_phone',
  /** Outside the 24-hour window, and the outreach limits refused (G-216). */
  'outreach_limit',
  /** The template names a fact this conversation has no recorded value for (G-215). */
  'missing_fact',
  /** The template is no longer approved and active at the time of sending. */
  'template_not_approved',
  /** The window or the limits could not be read; the row is refused rather than guessed. */
  'unreadable',
  /** The message row could not be recorded, so nothing was handed to the provider. */
  'record_failed',
  /** The campaign was cancelled before this row was reached. */
  'cancelled',
] as const;
export type CampaignRefusalReason = (typeof CAMPAIGN_REFUSAL_REASONS)[number];

export const CAMPAIGN_REFUSAL_LABELS: Readonly<Record<CampaignRefusalReason, string>> = {
  no_conversation: 'No WhatsApp thread for this lead',
  no_consent: 'No recorded consent',
  thread_not_found: 'Thread no longer exists',
  no_phone: 'No phone number',
  outreach_limit: 'Outreach limit reached',
  missing_fact: 'Template fact missing',
  template_not_approved: 'Template not approved and active',
  unreadable: 'Window or limits could not be read',
  record_failed: 'Message could not be recorded',
  cancelled: 'Campaign cancelled',
};

export function isCampaignRefusalReason(value: string): value is CampaignRefusalReason {
  return (CAMPAIGN_REFUSAL_REASONS as readonly string[]).includes(value);
}

/** What the per-recipient table prints for a reason: the label for a known one, the words as recorded otherwise. */
export function describeRefusal(reason: string | null): string {
  if (!reason) return '—';
  return isCampaignRefusalReason(reason) ? CAMPAIGN_REFUSAL_LABELS[reason] : reason;
}

/** The audience filter as the form and the URL carry it — every field optional, strings only. */
export type CampaignAudienceInput = {
  status?: string;
  source?: string;
  owner?: string;
  service?: string;
  tag?: string;
  lastActivityDays?: string;
  createdFrom?: string;
  createdTo?: string;
  projectId?: string;
};

export type CampaignPreviewState =
  | { status: 'ok'; count: number; withThread: number; withoutThread: number }
  | { status: 'error'; message: string };
