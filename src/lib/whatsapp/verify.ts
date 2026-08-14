import { createHmac } from 'node:crypto';

import { constantTimeEquals } from '../constant-time';

/**
 * The inbound WhatsApp webhook's two authorization decisions, lifted out of the
 * route for the same reason src/lib/cron-auth.ts was: they are the part worth
 * being certain about, and asserting them should not require booting Next, a
 * Supabase client and a signing key.
 *
 * Both take their secret as an argument rather than reading the environment, so
 * a test supplies its own and nothing here can leak a configured one.
 *
 * Nothing in this module logs, echoes or returns any part of a secret, a token
 * or a signature. Every failure body is a constant.
 */

export type WebhookAuth =
  | { ok: true }
  /**
   * Refused. 503 when the deployment configured no secret — the webhook is
   * *disabled* rather than *forbidden*, which is the honest answer and stops an
   * unconfigured deployment from accepting unsigned traffic. 403 for a failed
   * subscription handshake, which is what Meta's verification flow expects.
   * 401 for a request whose signature does not check out.
   */
  | { ok: false; status: 401 | 403 | 503; error: string };

/** Returned when the deployment has not configured the webhook. */
export const WEBHOOK_DISABLED = 'whatsapp webhook disabled: not configured';

/** Returned for every failed handshake, whatever was wrong with it. */
export const WEBHOOK_FORBIDDEN = 'forbidden';

/** Returned for every rejected signature, whatever was wrong with it. */
export const WEBHOOK_UNAUTHORIZED = 'unauthorized';

/** The header Meta signs each delivery with. */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

/** The only mode Meta uses to establish a subscription. */
const SUBSCRIBE = 'subscribe';

/**
 * Decides whether a subscription handshake may be answered with its challenge.
 *
 * Meta calls the webhook with `hub.mode=subscribe`, the token configured in the
 * app dashboard, and a random `hub.challenge` it expects echoed back verbatim.
 * Echoing the challenge is what proves ownership of the endpoint, so it must
 * happen only when the token matches exactly.
 *
 * The mode is checked as well as the token: a request that presents the right
 * token under a mode we do not implement is refused rather than guessed at.
 *
 * @param params the request's query string
 * @param token  the configured WHATSAPP_VERIFY_TOKEN, or undefined when unset
 */
export function authorizeSubscription(
  params: URLSearchParams,
  token: string | undefined,
): WebhookAuth & { challenge?: string } {
  if (!token) return { ok: false, status: 503, error: WEBHOOK_DISABLED };

  const mode = params.get('hub.mode');
  const presented = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode !== SUBSCRIBE) return { ok: false, status: 403, error: WEBHOOK_FORBIDDEN };
  if (challenge === null) return { ok: false, status: 403, error: WEBHOOK_FORBIDDEN };
  if (!presented || !constantTimeEquals(presented, token)) {
    return { ok: false, status: 403, error: WEBHOOK_FORBIDDEN };
  }

  return { ok: true, challenge };
}

/**
 * Decides whether a delivery genuinely came from Meta.
 *
 * The signature is an HMAC-SHA256 of the **raw request body** keyed by the app
 * secret, presented as `sha256=<hex>`. It must be computed over the exact bytes
 * received: re-serialising the parsed JSON would reorder keys and change
 * whitespace, and the digest would never match. The route therefore reads the
 * body as text once and passes that same string here and to the parser.
 *
 * @param rawBody   the request body exactly as received
 * @param presented the X-Hub-Signature-256 header, or null when absent
 * @param secret    the configured WHATSAPP_APP_SECRET, or undefined when unset
 */
export function authorizeSignature(
  rawBody: string,
  presented: string | null | undefined,
  secret: string | undefined,
): WebhookAuth {
  if (!secret) return { ok: false, status: 503, error: WEBHOOK_DISABLED };
  if (!presented) return { ok: false, status: 401, error: WEBHOOK_UNAUTHORIZED };

  const [scheme, digest] = presented.split('=', 2);
  if (scheme !== 'sha256' || !digest) {
    return { ok: false, status: 401, error: WEBHOOK_UNAUTHORIZED };
  }

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  if (!constantTimeEquals(digest, expected)) {
    return { ok: false, status: 401, error: WEBHOOK_UNAUTHORIZED };
  }
  return { ok: true };
}
