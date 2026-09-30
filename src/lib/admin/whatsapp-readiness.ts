import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';
import { secretConfigured } from '@/lib/secrets/resolve';

/**
 * Can this deployment send on WhatsApp at all? — the honest gate a send
 * button needs before it is drawn (owner decision 2026-09-29: an invoice is
 * sent over WhatsApp, so the page must say when it cannot be).
 *
 * Two facts, the same two `src/lib/admin/integrations.ts` reports: the token
 * in the environment and the organization's own phone number id. Neither is
 * a secret to name; the reason says which one is missing so the person
 * knows which screen fixes it.
 */
export type WhatsAppReadiness = { ok: true } | { ok: false; reason: string };

export async function readWhatsAppReadiness(): Promise<WhatsAppReadiness> {
  const tokenConfigured = await secretConfigured('WHATSAPP_ACCESS_TOKEN');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('organizations').select('settings').limit(1).maybeSingle();
  if (error) unreadable('readWhatsAppReadiness', error);
  const settings = (data?.settings ?? {}) as Record<string, unknown>;
  const numberConfigured =
    typeof settings.whatsapp_phone_number_id === 'string' && settings.whatsapp_phone_number_id.trim().length > 0;

  if (!tokenConfigured && !numberConfigured) {
    return { ok: false, reason: 'WHATSAPP_ACCESS_TOKEN is not set (add it under Security & Audit › Keys & secrets) and no WhatsApp number is registered under Settings › Communication.' };
  }
  if (!tokenConfigured) {
    return { ok: false, reason: 'WHATSAPP_ACCESS_TOKEN is not set, so nothing can be sent — add it under Security & Audit › Keys & secrets.' };
  }
  if (!numberConfigured) {
    return { ok: false, reason: 'No WhatsApp number is registered for this organization under Settings › Communication.' };
  }
  return { ok: true };
}
