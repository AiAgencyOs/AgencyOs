import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The engines' door into the shared identity layer (20261015200000). Every engine - email, social, B2B, the ad
 * channels' WhatsApp arrivals - resolves a person through `resolveIdentity` rather than inserting a contact, so
 * "one person, one identity" is a property of the system and not of each engine's discipline.
 *
 * These run as the service role (no session): the organisation is an argument, never inferred.
 */

export type IdentitySignals = {
  name?: string;
  company?: string;
  email?: string;
  phone?: string;
  website?: string;
  linkedin?: string;
  instagram?: string;
  facebook?: string;
  /** `platform:id`, e.g. `upwork:12345`. */
  b2b?: string;
};

export type IdentityOutcome = 'matched' | 'created' | 'created_pending_review' | 'conflict' | 'no_signals' | 'invalid' | 'forbidden';

export async function resolveIdentity(
  admin: Admin,
  organizationId: string,
  signals: IdentitySignals,
  source: string,
): Promise<{ outcome: IdentityOutcome; contactId: string | null; reviewId: string | null; created: boolean }> {
  const { data, error } = await admin.schema('crm').rpc('resolve_identity', {
    p_organization_id: organizationId,
    p_signals: signals as unknown as Json,
    p_source: source,
  });
  if (error) throw new Error(`resolveIdentity failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; contact_id?: string | null; review_id?: string | null; created?: boolean } | undefined;
  return {
    outcome: (row?.outcome ?? 'invalid') as IdentityOutcome,
    contactId: row?.contact_id ?? null,
    reviewId: row?.review_id ?? null,
    created: row?.created ?? false,
  };
}

export type TouchpointInput = {
  organizationId: string;
  leadId: string;
  channel: 'meta_ads' | 'email' | 'social' | 'google_ads' | 'b2b' | 'whatsapp' | 'web_form' | 'referral' | 'import' | 'manual';
  touchType: 'lead_created' | 'discovered' | 'outreach_sent' | 'reply_received' | 'inbound_message' | 'ad_click' | 'content_interaction' | 'profile_inquiry' | 'handoff' | 'meeting' | 'quotation';
  platform?: string;
  campaign?: Record<string, string | number | null>;
  utm?: Record<string, string>;
  /** Makes recording idempotent per channel: a replayed webhook or job records nothing twice. */
  externalRef?: string;
  occurredAt?: Date;
  correlationId?: string;
};

export async function recordTouchpoint(admin: Admin, input: TouchpointInput): Promise<'recorded' | 'duplicate' | 'unknown_lead' | 'invalid' | 'forbidden'> {
  const { data, error } = await admin.schema('crm').rpc('record_touchpoint', {
    p_organization_id: input.organizationId,
    p_lead: input.leadId,
    p_channel: input.channel,
    p_platform: input.platform as never,
    p_touch_type: input.touchType,
    p_campaign: (input.campaign ?? {}) as unknown as Json,
    p_utm: (input.utm ?? {}) as unknown as Json,
    p_external_ref: input.externalRef,
    p_occurred_at: input.occurredAt?.toISOString(),
    p_correlation_id: input.correlationId,
  });
  if (error) throw new Error(`recordTouchpoint failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  return (row?.outcome ?? 'invalid') as 'recorded';
}

export const CONVERSATION_OWNERS = ['email_outreach', 'social_media', 'b2b_opportunity', 'sales', 'human'] as const;
export type ConversationOwner = (typeof CONVERSATION_OWNERS)[number];

/**
 * Transfer who may negotiate with a lead. `expectedFrom` is what the caller BELIEVES the owner is (null = nobody):
 * if another agent got there first the answer is `stale`, and the caller must reload rather than act on old state.
 */
export async function transferConversationOwner(
  admin: Admin,
  input: { organizationId: string; leadId: string; expectedFrom: ConversationOwner | null; to: ConversationOwner; reason: string; workflowState?: string; context?: Record<string, unknown>; correlationId?: string },
): Promise<'transferred' | 'unchanged' | 'stale' | 'closed' | 'invalid' | 'unknown_lead' | 'forbidden'> {
  const { data, error } = await admin.schema('crm').rpc('transfer_conversation_owner', {
    p_organization_id: input.organizationId,
    p_lead: input.leadId,
    p_expected_from: input.expectedFrom as never,
    p_to: input.to,
    p_reason: input.reason,
    p_workflow_state: input.workflowState,
    p_context: (input.context ?? {}) as unknown as Json,
    p_correlation_id: input.correlationId,
  });
  if (error) throw new Error(`transferConversationOwner failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  return (row?.outcome ?? 'invalid') as 'transferred';
}
