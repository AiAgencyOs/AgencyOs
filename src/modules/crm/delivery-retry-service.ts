import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { retryFailedDeliverySchema, type RetryFailedDeliveryInput } from './delivery-retry-schema';
import { sendClientMessage } from './service';

export type Retried = { messageId: string; attempt: number; delivered: boolean };

/**
 * Re-sends a failed outbound message — SCR-057, with SCR-060's history.
 *
 * A retry is a NEW send of the same body through `sendClientMessage`, the
 * door every staff-sent message goes through, so the 24-hour window and the
 * consent rule decide it again and their refusals come back verbatim.
 * Nothing here talks to the provider directly.
 *
 * The idempotency key is derived from the original and its attempt number,
 * so a double click cannot send twice and a retry whose link was lost can be
 * found again by its key. After the send — whatever it answered — the new
 * row is looked up by that key and linked to the original through
 * `crm.record_delivery_retry`, which sets `retry_of` and bumps the
 * original's `retry_count` in one audited transaction. A retry that itself
 * failed is therefore still on record as an attempt, with its reason.
 *
 * Gated on `lead.write`, as sending is. The link door re-checks owner or
 * ops_admin, the roles the transcript's sanctioned UPDATE policy admits.
 */
export async function retryFailedDelivery(input: RetryFailedDeliveryInput): Promise<Result<Retried>> {
  const parsed = retryFailedDeliverySchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'That is not a message id.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to message clients.');
  }

  const supabase = await createClient();
  const { data: original, error: readError } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('id, conversation_id, body, metadata, retry_count')
    .eq('id', parsed.data.messageId)
    .maybeSingle();
  if (readError) {
    console.error(JSON.stringify({ level: 'error', scope: 'retryFailedDelivery', detail: readError.message }));
    return err('INTERNAL', 'Could not load the message.');
  }
  if (!original) return err('NOT_FOUND', 'Message not found.');

  const meta = (original.metadata ?? {}) as Record<string, unknown>;
  if (meta.direction !== 'outbound' || meta.delivery !== 'failed') {
    return err('CONFLICT', 'Only a failed outbound message can be retried; this one is not.');
  }

  const attempt = original.retry_count + 1;
  const key = `retry-${original.id}-${attempt}`;

  const sent = await sendClientMessage({
    conversationId: original.conversation_id,
    body: original.body,
    idempotencyKey: key,
  });

  // Link whatever row the send produced, so a refused retry is still an
  // attempt on the record. A send refused before any row was written (no
  // consent) leaves nothing to link, and that is the truth of it.
  const { data: retryRow } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('id')
    .eq('external_ref', key)
    .maybeSingle();

  if (retryRow) {
    const { error: linkError } = await supabase.schema('crm').rpc('record_delivery_retry', {
      p_original_id: original.id,
      p_retry_id: retryRow.id,
    });
    if (linkError) {
      console.error(JSON.stringify({ level: 'error', scope: 'retryFailedDelivery.link', detail: linkError.message }));
    }
  }

  if (!sent.ok) return sent;
  return ok({ messageId: sent.data.messageId, attempt, delivered: sent.data.delivered });
}
