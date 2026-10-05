import { createHmac } from 'node:crypto';

import { constantTimeEquals } from '../constant-time';

/**
 * The inbound-email webhook's authorization decision — audit step 1.1.
 *
 * ── the assumption, stated rather than hidden ─────────────────────────────
 *
 * No email provider is configured anywhere in this codebase (`src/lib/env.ts`
 * had no email variable before this change, and `.env.example` names none).
 * This is written against Mailgun's documented "Inbound Route" webhook
 * signature scheme, because it is a real, publicly documented scheme rather
 * than one invented for this change — but it is a guess at the agency's actual
 * provider, not a verified integration. If the real provider differs (e.g. a
 * scheme that signs the whole body, as WhatsApp's does), this is the one file
 * to replace; `app/api/webhooks/email/route.ts` calls only the two functions
 * below and knows nothing about the scheme underneath them.
 *
 * Mailgun signs `timestamp + token` (concatenated, no separator) with
 * HMAC-SHA256 keyed by the account's webhook signing key, and delivers all
 * three fields as separate multipart/form-data fields on every request rather
 * than as one header — unlike WhatsApp's single `X-Hub-Signature-256` over the
 * raw body. The verification is otherwise the same shape as
 * `src/lib/whatsapp/verify.ts`: the secret is an argument, never read from the
 * environment here, so a test supplies its own and nothing here can leak a
 * configured one; nothing logs, echoes or returns any part of a secret or
 * signature.
 */

export type EmailWebhookAuth =
  | { ok: true }
  /** 503 — the deployment configured no signing key, so the webhook is disabled rather than accepting unsigned mail. 401 — the signature did not check out. */
  | { ok: false; status: 401 | 503; error: string };

export const EMAIL_WEBHOOK_DISABLED = 'email webhook disabled: not configured';
export const EMAIL_WEBHOOK_UNAUTHORIZED = 'unauthorized';

/**
 * Mailgun rejects a webhook whose timestamp is more than 15 minutes old — the
 * replay window for a captured signature. Mirrored here for the same reason.
 */
const MAX_TIMESTAMP_SKEW_SECONDS = 15 * 60;

/**
 * Decides whether an inbound email delivery genuinely came from the
 * configured provider.
 *
 * @param timestamp the `timestamp` field from the webhook payload
 * @param token     the `token` field from the webhook payload
 * @param signature the `signature` field from the webhook payload (hex HMAC-SHA256)
 * @param secret    the configured EMAIL_INBOUND_SIGNING_KEY, or undefined when unset
 */
export function authorizeEmailSignature(
  timestamp: string | null | undefined,
  token: string | null | undefined,
  signature: string | null | undefined,
  secret: string | undefined,
): EmailWebhookAuth {
  if (!secret) return { ok: false, status: 503, error: EMAIL_WEBHOOK_DISABLED };
  if (!timestamp || !token || !signature) {
    return { ok: false, status: 401, error: EMAIL_WEBHOOK_UNAUTHORIZED };
  }

  const asNumber = Number(timestamp);
  if (!Number.isFinite(asNumber)) {
    return { ok: false, status: 401, error: EMAIL_WEBHOOK_UNAUTHORIZED };
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - asNumber);
  if (ageSeconds > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, status: 401, error: EMAIL_WEBHOOK_UNAUTHORIZED };
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}${token}`, 'utf8').digest('hex');

  if (!constantTimeEquals(signature, expected)) {
    return { ok: false, status: 401, error: EMAIL_WEBHOOK_UNAUTHORIZED };
  }
  return { ok: true };
}
