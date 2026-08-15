import 'server-only';

import { serverEnv } from '@/lib/env';

/**
 * Talking to WhatsApp — gap G-014, decision ADM-09.
 *
 * The Graph API's send endpoint, and nothing else. The decision about *whether*
 * to send belongs to the caller and to the row it wrote first; this file's only
 * job is the HTTP call and an honest answer about it.
 *
 * ADM-09 was taken under the Admin's blanket delegation rather than answered,
 * and it was the narrowest decision available: `src/lib/whatsapp/verify.ts` and
 * the inbound webhook already speak WhatsApp Cloud API, so outbound over the
 * same Graph API adds no vendor, no second identity and no second phone
 * number. A different channel would have been an invention; this is the other
 * half of the one already in use.
 *
 * Inert without credentials, on the CRON_SECRET pattern the rest of this
 * repository follows: no token, no send, and the caller is told exactly that
 * rather than discovering a silent no-op.
 */

/** Where the Graph API lives. Overridable so a test can point at a stub. */
const DEFAULT_BASE = 'https://graph.facebook.com/v21.0';

export type SentMessage = { providerRef: string };

/**
 * The provider's answer, classified for the retry loop.
 *
 * A uniform "provider error" made every failure look retryable, so an invalid
 * recipient or a malformed request retried until the job's attempt ceiling —
 * noise for something a retry can never fix. `permanent` separates the two:
 *
 *   permanent  a 4xx that is not 429 (bad request, auth, unknown recipient),
 *              and a missing tenant phone number — retrying sends the same
 *              request to the same "no".
 *   transient  429, any 5xx, a transport failure or timeout, a 200 with no
 *              message id, and a missing deployment token (which a later
 *              deploy supplies) — the message may still land on a retry.
 */
export type SendResult =
  | { ok: true; providerRef: string }
  | { ok: false; permanent: boolean; message: string };

/**
 * Send one text message.
 *
 * `phoneNumberId` is the organization's own WhatsApp account, read from its
 * settings by `crm.send_outbound_message` rather than from configuration here
 * — two agencies on one deployment must not be able to send as each other,
 * and the number that identifies them is tenant data, not a deployment
 * secret. The token is the deployment's.
 */
export async function sendWhatsAppText(input: {
  phoneNumberId: string;
  to: string;
  body: string;
  /**
   * How to address the recipient — Meta's Groups API takes a different
   * envelope for each:
   *
   *   individual: { recipient_type: 'individual', to: '<phone>' }
   *   group:      { recipient_type: 'group',      to: '<group id>' }
   *
   * Defaulted to 'individual' because every caller before G-110 sent to a
   * person, and a default that matches the old behaviour keeps this change
   * about groups rather than about every send site. `crm.send_outbound_message`
   * returns the right value, so no caller has to work it out.
   */
  recipientType?: 'individual' | 'group';
}): Promise<SendResult> {
  const env = serverEnv();

  if (!env.WHATSAPP_ACCESS_TOKEN) {
    // Transient: a deployment that has not set its token yet may set it, and
    // permanently stopping a follow-up sequence over a deploy gap would be
    // the wrong answer to a fixable state.
    return { ok: false, permanent: false, message: 'WhatsApp sending is not configured on this deployment.' };
  }

  if (!input.phoneNumberId) {
    // Permanent: the organization has no number of its own. Retrying the same
    // org sends nothing different — somebody has to set it.
    return { ok: false, permanent: true, message: 'This organization has no WhatsApp number configured, so nothing can be sent from it.' };
  }

  const base = env.WHATSAPP_GRAPH_BASE_URL ?? DEFAULT_BASE;

  let response: Response;
  try {
    response = await fetch(`${base}/${input.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: input.recipientType ?? 'individual',
        to: input.to,
        type: 'text',
        text: { preview_url: false, body: input.body },
      }),
      cache: 'no-store',
      // A client-facing send that hangs holds a Server Action open. Ten
      // seconds is long enough for a slow API and short enough that the
      // person clicking learns something.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    // Transport failure or timeout. The message row already exists and stays
    // pending, so this is recoverable rather than lost — the reason it was
    // written first.
    const detail = cause instanceof Error ? cause.message : 'unknown';
    console.error(JSON.stringify({ level: 'error', scope: 'sendWhatsAppText', detail }));
    return { ok: false, permanent: false, message: 'WhatsApp could not be reached.' };
  }

  const text = await response.text();

  if (!response.ok) {
    // Logged in full, reported in summary: a Graph error body carries the
    // token's scopes and the account id, and neither belongs on a screen.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'sendWhatsAppText',
        status: response.status,
        detail: text.slice(0, 500),
      }),
    );
    // A 4xx that is not 429 is the provider saying no to THIS request — bad
    // recipient, bad auth, malformed body — and a retry sends the same no.
    // 429 (rate limit) and every 5xx are the provider saying not now.
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    return { ok: false, permanent, message: `WhatsApp refused the message (${response.status}).` };
  }

  let providerRef: string | undefined;
  try {
    const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
    providerRef = parsed.messages?.[0]?.id;
  } catch {
    providerRef = undefined;
  }

  if (!providerRef) {
    // A 200 with no message id is not a success anybody can reconcile later.
    // Transient: the next attempt may come back with an id.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'sendWhatsAppText',
        detail: `accepted with no message id: ${text.slice(0, 200)}`,
      }),
    );
    return { ok: false, permanent: false, message: 'WhatsApp accepted the message without identifying it.' };
  }

  return { ok: true, providerRef };
}
