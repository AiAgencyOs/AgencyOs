import 'server-only';

import { interpretVerify, type WhatsAppVerifyResult } from '@/lib/admin/whatsapp-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { serverEnv } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';

/**
 * "Verify WhatsApp configuration" — Phase 3 of the Admin control-center mandate,
 * and the one hard constraint it names: it must NOT send a customer message.
 *
 * So it makes a NON-MESSAGE Graph call — a GET on the org's own phone-number
 * node — which asks Meta only whether the token and number are valid and
 * returns the number's public metadata. No `/messages` POST, no recipient, no
 * customer touched. The access token travels only in the Authorization header;
 * it is never returned, logged, or echoed, and Meta's public facts
 * (verified_name, display number, quality rating) are not secrets.
 *
 * Short-circuits before any network call when the token or number is unset, so
 * a deployment without WhatsApp configured makes no external request at all and
 * reports the exact setup that is missing.
 */

const DEFAULT_BASE = 'https://graph.facebook.com/v21.0';
const TIMEOUT_MS = 8_000;

export async function verifyWhatsAppConfig(): Promise<Result<WhatsAppVerifyResult>> {
  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to verify configuration.');
  }

  const env = serverEnv();
  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return err(
      'VALIDATION',
      'WHATSAPP_ACCESS_TOKEN is not set — outbound WhatsApp is disabled. Set it in the deployment environment (never here).',
    );
  }

  const supabase = await createClient();
  const { data: org } = await supabase.schema('core').from('organizations').select('settings').limit(1);
  const settings = (org?.[0]?.settings ?? {}) as Record<string, unknown>;
  const phoneNumberId = typeof settings.whatsapp_phone_number_id === 'string' ? settings.whatsapp_phone_number_id.trim() : '';
  if (!phoneNumberId) {
    return err('VALIDATION', 'No WhatsApp phone number id is configured for this organization.');
  }

  const base = env.WHATSAPP_GRAPH_BASE_URL ?? DEFAULT_BASE;
  let res: Response;
  try {
    res = await fetch(
      `${base}/${encodeURIComponent(phoneNumberId)}?fields=verified_name,display_phone_number,quality_rating`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      },
    );
  } catch (error) {
    return err('INTERNAL', `Could not reach the WhatsApp Graph API: ${error instanceof Error ? error.message : 'unreachable'}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  // interpretVerify never sees the token and returns only safe strings.
  return ok(interpretVerify(res.status, body));
}
