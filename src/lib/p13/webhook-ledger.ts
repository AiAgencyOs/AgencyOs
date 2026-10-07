import { createHash } from 'node:crypto';

import type { createAdminClient } from '@/lib/db/admin';

/**
 * P1-MP3-030 / P1-API-018: every inbound webhook delivery is written to `core.p13_webhook_events` BEFORE it is acted on, and the door says what to do:
 *
 *   accepted             new and authenticated and fresh: process it, then call `finishWebhookDelivery`
 *   duplicate            already seen: answer 200 and do nothing (idempotent)
 *   rejected_signature   bad or missing signature: answer 401, mutate nothing
 *   rejected_stale       outside the replay window: answer 400/409, mutate nothing
 *   rejected_malformed   no usable event key: answer 400
 *
 * Only a SHA-256 of the body and its size are stored, never the body. The ledger FAILS LOUD to the caller (it throws on a transport error) because the
 * route must decide: a webhook route that cannot reach its ledger should answer 503 and let the provider redeliver, not process unrecorded.
 */
type Admin = ReturnType<typeof createAdminClient>;
type Rpc = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };

export type WebhookOutcome = 'accepted' | 'duplicate' | 'rejected_signature' | 'rejected_stale' | 'rejected_malformed';
const OUTCOMES: readonly WebhookOutcome[] = ['accepted', 'duplicate', 'rejected_signature', 'rejected_stale', 'rejected_malformed'];

export type WebhookDelivery = {
  organizationId: string | null;
  provider: string;
  eventKey: string | null;
  signatureStatus: 'valid' | 'invalid' | 'missing' | 'not_applicable';
  eventAt?: Date | null;
  normalizedType?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  body?: string | Uint8Array | null;
  maxAgeSeconds?: number;
  correlationId?: string | null;
};
export type WebhookDecision = { outcome: WebhookOutcome; eventId: string; duplicateOf: string | null };

export function sha256Hex(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

export function httpStatusForOutcome(outcome: WebhookOutcome): number {
  switch (outcome) {
    case 'accepted':
    case 'duplicate':
      return 200;
    case 'rejected_signature':
      return 401;
    case 'rejected_stale':
      return 409;
    case 'rejected_malformed':
      return 400;
  }
}

export async function recordWebhookDelivery(admin: Admin, d: WebhookDelivery): Promise<WebhookDecision> {
  const core = admin.schema('core') as unknown as Rpc;
  const bytes = d.body === null || d.body === undefined ? null : typeof d.body === 'string' ? Buffer.byteLength(d.body) : d.body.byteLength;
  const { data, error } = await core.rpc('p13_record_webhook_event', {
    p_organization_id: d.organizationId,
    p_provider: d.provider,
    p_event_key: d.eventKey,
    p_signature_status: d.signatureStatus,
    p_event_at: d.eventAt ? d.eventAt.toISOString() : null,
    p_normalized_type: d.normalizedType ?? null,
    p_resource_type: d.resourceType ?? null,
    p_resource_id: d.resourceId ?? null,
    p_payload_sha256: d.body === null || d.body === undefined ? null : sha256Hex(d.body),
    p_payload_bytes: bytes,
    p_max_age_seconds: d.maxAgeSeconds ?? 900,
    p_correlation_id: d.correlationId ?? null,
  });
  if (error) throw new Error(`webhook ledger unreachable: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; event_id?: string; duplicate_of?: string | null } | null | undefined;
  if (!row || !row.event_id || !OUTCOMES.includes(row.outcome as WebhookOutcome)) throw new Error('webhook ledger answered nothing usable');
  return { outcome: row.outcome as WebhookOutcome, eventId: row.event_id, duplicateOf: row.duplicate_of ?? null };
}

export async function finishWebhookDelivery(admin: Admin, eventId: string, result: { ok: true } | { ok: false; errorClass: string }): Promise<'processed' | 'failed' | 'not_accepted' | 'not_found'> {
  const core = admin.schema('core') as unknown as Rpc;
  const { data, error } = await core.rpc('p13_finish_webhook_event', {
    p_event_id: eventId,
    p_ok: result.ok,
    p_error_class: result.ok ? null : result.errorClass,
  });
  if (error) throw new Error(`webhook ledger unreachable: ${error.message}`);
  if (data !== 'processed' && data !== 'failed' && data !== 'not_accepted' && data !== 'not_found') throw new Error('webhook ledger answered nothing usable');
  return data;
}
