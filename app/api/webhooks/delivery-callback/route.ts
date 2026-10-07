import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { DELIVERY_CALLBACK_SIGNATURE_HEADER, handleDeliveryCallback } from '@/modules/projects/provider-delivery-callback';

/**
 * /api/webhooks/delivery-callback: a signed, normalised delivery fact for a message a person recorded (see provider-delivery-callback.ts).
 * Disabled (503) until BOTH `COMMUNICATION_CALLBACK_SECRET` and `COMMUNICATION_CALLBACK_ORGANIZATION_ID` are set. Thin: read the body, hand over, answer.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 64 * 1024;

export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  const result = await handleDeliveryCallback(raw, request.headers.get(DELIVERY_CALLBACK_SIGNATURE_HEADER), {
    secret: process.env.COMMUNICATION_CALLBACK_SECRET,
    organizationId: process.env.COMMUNICATION_CALLBACK_ORGANIZATION_ID,
    record: async (organizationId, e) => {
      const supabase = createAdminClient();
      const { data, error } = await supabase.schema('projects').rpc('record_provider_delivery_callback' as never, {
        p_organization_id: organizationId, p_provider: e.provider, p_channel: e.channel, p_external_ref: e.externalRef, p_event: e.event, p_occurred_at: e.occurredAt,
      } as never);
      if (error) throw new Error('database');
      const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
      return String(row.outcome ?? 'no_answer');
    },
  });
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
