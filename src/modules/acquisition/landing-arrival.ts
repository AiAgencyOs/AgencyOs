import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

type Admin = ReturnType<typeof createAdminClient>;

/** The tag a landing page's button puts in the pre-filled WhatsApp message: LP-<version>-<ad campaign>. */
export const LANDING_TAG = /LP-[0-9a-f]{8}-[A-Za-z0-9_]{1,40}/;

/**
 * Called by ingest AFTER a message is recorded. The database door reads the tag out of the text itself and only ever adds a touchpoint;
 * this wrapper just decides whether it is worth asking. Best effort and NEVER throws: bookkeeping must not lose the message it rides on.
 */
export async function recordLandingArrivalAfterIngest(admin: Admin, input: { organizationId: string; leadId: string; body: string | null; occurredAt: string }): Promise<string | null> {
  if (!input.body || !LANDING_TAG.test(input.body)) return null;
  try {
    const { data, error } = await admin.schema('crm').rpc('record_landing_arrival', {
      p_organization_id: input.organizationId, p_lead: input.leadId, p_message: input.body, p_message_at: input.occurredAt,
    });
    if (error) throw new Error(error.message);
    return ((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? null;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordLandingArrivalAfterIngest', detail: e instanceof Error ? e.message : 'unknown' }));
    return null;
  }
}
