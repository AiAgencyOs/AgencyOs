import 'server-only';

import { err, ok, type Result } from '@/lib/result';
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
}): Promise<Result<SentMessage>> {
  const env = serverEnv();

  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return err(
      'PROVIDER_ERROR',
      'WhatsApp sending is not configured on this deployment.',
    );
  }

  if (!input.phoneNumberId) {
    return err(
      'VALIDATION',
      'This organization has no WhatsApp number configured, so nothing can be sent from it.',
    );
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
        recipient_type: 'individual',
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
    // The message row already exists and stays pending, so a transport failure
    // is recoverable rather than lost — which is the reason it was written
    // first.
    const detail = cause instanceof Error ? cause.message : 'unknown';
    console.error(JSON.stringify({ level: 'error', scope: 'sendWhatsAppText', detail }));
    return err('PROVIDER_ERROR', 'WhatsApp could not be reached.');
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
    return err('PROVIDER_ERROR', `WhatsApp refused the message (${response.status}).`);
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
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'sendWhatsAppText',
        detail: `accepted with no message id: ${text.slice(0, 200)}`,
      }),
    );
    return err('PROVIDER_ERROR', 'WhatsApp accepted the message without identifying it.');
  }

  return ok({ providerRef });
}
