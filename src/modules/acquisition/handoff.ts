import 'server-only';

import { randomUUID } from 'node:crypto';

import type { createAdminClient } from '@/lib/db/admin';
import { clientEnv, serverEnv } from '@/lib/env';

import { deriveHandoffCode, handoffLink, hashHandoffCode } from './handoff-code';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The tracked WhatsApp handoff, application half (20261015300000). The rules - one live handoff per lead, the
 * frozen context, the state machine, the safe bind, replay and cross-tenant protection - live in the database doors;
 * this file derives the reference, calls the doors, and turns an outcome into something an engine can branch on.
 */

export const HANDOFF_SOURCE_CHANNELS = ['meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other'] as const;
export const HANDOFF_SOURCE_AGENTS = ['email_outreach', 'social_media', 'b2b_opportunity', 'ad_manager', 'sales', 'human'] as const;

export function handoffSecret(): string {
  const env = serverEnv();
  return env.VAULT_ENCRYPTION_KEY || env.CRON_SECRET || '';
}

export type CreatedHandoff = {
  outcome: 'created' | 'exists';
  handoffId: string;
  expiresAt: string;
  /** The reference a prospect types or taps. Shown to the engine once; never stored. */
  code: string;
  /** The public link that opens WhatsApp with the reference pre-filled. */
  link: string;
};

export type CreateHandoffRefusal = 'forbidden' | 'invalid' | 'unknown_lead' | 'lead_merged' | 'closed';

/**
 * Create (or re-find) the handoff for a lead. Idempotent: a retried job gets the SAME handoff and the SAME reference
 * back, because the reference is derived from the handoff's id and the door returns the live handoff's id.
 */
export async function createHandoff(
  admin: Admin,
  input: {
    organizationId: string;
    leadId: string;
    sourceChannel: (typeof HANDOFF_SOURCE_CHANNELS)[number];
    sourcePlatform?: string;
    sourceAgent: (typeof HANDOFF_SOURCE_AGENTS)[number];
    nextAction?: string;
    ttlDays?: number;
    correlationId?: string;
  },
): Promise<{ ok: true; handoff: CreatedHandoff } | { ok: false; refusal: CreateHandoffRefusal }> {
  const secret = handoffSecret();
  const appUrl = clientEnv.NEXT_PUBLIC_APP_URL ?? '';
  if (!secret || !appUrl) throw new Error('a handoff needs a signing secret and the app URL');

  const proposedId = randomUUID();
  const { data, error } = await admin.schema('crm').rpc('create_channel_handoff', {
    p_organization_id: input.organizationId,
    p_handoff_id: proposedId,
    p_token_hash: hashHandoffCode(deriveHandoffCode(proposedId, secret)),
    p_lead: input.leadId,
    p_source_channel: input.sourceChannel,
    p_source_platform: input.sourcePlatform as never,
    p_source_agent: input.sourceAgent,
    p_next_action: input.nextAction as never,
    p_ttl_days: input.ttlDays as never,
    p_correlation_id: input.correlationId as never,
  });
  if (error) throw new Error(`createHandoff failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; handoff_id?: string | null; expires_at?: string | null } | undefined;
  if ((row?.outcome === 'created' || row?.outcome === 'exists') && row.handoff_id && row.expires_at) {
    const code = deriveHandoffCode(row.handoff_id, secret);
    return { ok: true, handoff: { outcome: row.outcome, handoffId: row.handoff_id, expiresAt: row.expires_at, code, link: handoffLink(appUrl, code) } };
  }
  return { ok: false, refusal: (row?.outcome ?? 'invalid') as CreateHandoffRefusal };
}

/** The sweep: unused links past their expiry become EXPIRED. Called from the cron tick. */
export async function expireHandoffs(admin: Admin): Promise<number> {
  const { data, error } = await admin.schema('crm').rpc('expire_channel_handoffs', { p_limit: 200 });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'expireHandoffs', detail: error.message }));
    return 0;
  }
  return Number(data ?? 0);
}
