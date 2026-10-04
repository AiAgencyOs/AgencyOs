import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { hashHandoffCode } from './handoff-code';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The two steps of the handoff that ride on an inbound WhatsApp message (20261015300000). Kept apart from
 * handoff.ts - which reads environment variables at import - so the ingest module stays importable by unit tests
 * and carries nothing it does not use. Both are best effort and NEVER throw: a handoff failure must not lose the
 * customer message it rides on.
 */

export type BoundHandoff = { handoffId: string; organizationId: string; outcome: 'bound' | 'review_needed' };

/**
 * Called by ingest BEFORE it records a message that carries a reference: makes the existing lead the WhatsApp thread
 * so the unchanged ingest continues it instead of opening a second lead. Never throws - a failure here must not lose
 * the message it rides on.
 */
export async function bindHandoffBeforeIngest(admin: Admin, input: { phoneNumberId: string; from: string; code: string }): Promise<BoundHandoff | null> {
  try {
    const { data, error } = await admin.schema('crm').rpc('bind_handoff_from_message', {
      p_phone_number_id: input.phoneNumberId,
      p_from: input.from,
      p_code_hash: hashHandoffCode(input.code),
    });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; handoff_id?: string | null; organization_id?: string | null } | undefined;
    if ((row?.outcome === 'bound' || row?.outcome === 'review_needed') && row.handoff_id && row.organization_id) {
      return { handoffId: row.handoff_id, organizationId: row.organization_id, outcome: row.outcome };
    }
    return null;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'bindHandoffBeforeIngest', detail: e instanceof Error ? e.message : 'unknown' }));
    return null;
  }
}

/** Called by ingest AFTER the message is recorded: finishes the move (ownership, touchpoint, or a review). Never throws. */
export async function consumeHandoffAfterIngest(admin: Admin, input: { bound: BoundHandoff; contactId: string; leadId: string }): Promise<string | null> {
  try {
    const { data, error } = await admin.schema('crm').rpc('consume_channel_handoff', {
      p_handoff_id: input.bound.handoffId,
      p_organization_id: input.bound.organizationId,
      p_contact_id: input.contactId,
      p_lead_id: input.leadId,
    });
    if (error) throw new Error(error.message);
    return ((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? null;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'consumeHandoffAfterIngest', detail: e instanceof Error ? e.message : 'unknown' }));
    return null;
  }
}
