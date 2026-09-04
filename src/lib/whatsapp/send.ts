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

/**
 * The provider's answer to an upload, classified the same way.
 *
 * An uploaded file has no `providerRef` — it is not a message yet. What comes
 * back is a media id, valid for thirty days, that a document message then
 * names. The classification rule is `SendResult`'s exactly, because the same
 * retry loop consumes both.
 */
export type UploadResult =
  | { ok: true; mediaId: string }
  | { ok: false; permanent: boolean; message: string };

/**
 * Upload one file to WhatsApp so a message can carry it.
 *
 * Two calls make a document reach a phone: this one hands the provider the
 * bytes, `sendWhatsAppDocument` below names the returned id in a message.
 * They are deliberately separate functions rather than one convenience,
 * because they fail differently — an upload failure leaves nothing to
 * reconcile, a send failure leaves an orphaned upload the provider expires
 * on its own — and the caller's row-first bookkeeping needs to know which
 * half died.
 *
 * The timeout is the byte-transfer budget (20s, the same as fetching inbound
 * media), not the JSON budget: a quotation PDF is tens of kilobytes today
 * and this is the one call in this file that carries a payload.
 */
export async function uploadWhatsAppMedia(input: {
  phoneNumberId: string;
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
}): Promise<UploadResult> {
  const env = serverEnv();

  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, permanent: false, message: 'WhatsApp sending is not configured on this deployment.' };
  }

  if (!input.phoneNumberId) {
    return { ok: false, permanent: true, message: 'This organization has no WhatsApp number configured, so nothing can be sent from it.' };
  }

  const base = env.WHATSAPP_GRAPH_BASE_URL ?? DEFAULT_BASE;

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', input.mediaType);
  form.append(
    'file',
    new Blob([input.bytes as BlobPart], { type: input.mediaType }),
    input.filename,
  );

  let response: Response;
  try {
    response = await fetch(`${base}/${input.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown';
    console.error(JSON.stringify({ level: 'error', scope: 'uploadWhatsAppMedia', detail }));
    return { ok: false, permanent: false, message: 'WhatsApp could not be reached.' };
  }

  const text = await response.text();

  if (!response.ok) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'uploadWhatsAppMedia',
        status: response.status,
        detail: text.slice(0, 500),
      }),
    );
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    return { ok: false, permanent, message: `WhatsApp refused the file (${response.status}).` };
  }

  let mediaId: string | undefined;
  try {
    // An upload answers { id } at the top level — not the messages[] envelope
    // a send answers with. The two shapes are easy to conflate in a stub, and
    // a stub that answers the wrong one fails HERE, loudly, not downstream.
    const parsed = JSON.parse(text) as { id?: string };
    mediaId = parsed.id;
  } catch {
    mediaId = undefined;
  }

  if (!mediaId) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'uploadWhatsAppMedia',
        detail: `accepted with no media id: ${text.slice(0, 200)}`,
      }),
    );
    return { ok: false, permanent: false, message: 'WhatsApp accepted the file without identifying it.' };
  }

  return { ok: true, mediaId };
}

/**
 * Send one document message naming an uploaded media id.
 *
 * No caption parameter, deliberately. The words that accompany a quotation
 * travel in a text message beside the document, where the transcript records
 * them verbatim and `crm.refuse_unread_price` can read them — a caption would
 * be a second body the row never sees.
 */
export async function sendWhatsAppDocument(input: {
  phoneNumberId: string;
  to: string;
  mediaId: string;
  filename: string;
  recipientType?: 'individual' | 'group';
}): Promise<SendResult> {
  const env = serverEnv();

  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, permanent: false, message: 'WhatsApp sending is not configured on this deployment.' };
  }

  if (!input.phoneNumberId) {
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
        type: 'document',
        document: { id: input.mediaId, filename: input.filename },
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown';
    console.error(JSON.stringify({ level: 'error', scope: 'sendWhatsAppDocument', detail }));
    return { ok: false, permanent: false, message: 'WhatsApp could not be reached.' };
  }

  const text = await response.text();

  if (!response.ok) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'sendWhatsAppDocument',
        status: response.status,
        detail: text.slice(0, 500),
      }),
    );
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    return { ok: false, permanent, message: `WhatsApp refused the document (${response.status}).` };
  }

  let providerRef: string | undefined;
  try {
    const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
    providerRef = parsed.messages?.[0]?.id;
  } catch {
    providerRef = undefined;
  }

  if (!providerRef) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'sendWhatsAppDocument',
        detail: `accepted with no message id: ${text.slice(0, 200)}`,
      }),
    );
    return { ok: false, permanent: false, message: 'WhatsApp accepted the document without identifying it.' };
  }

  return { ok: true, providerRef };
}

/**
 * A message Meta will carry when the 24-hour window has shut — G-213.
 *
 * ── why this exists at all ────────────────────────────────────────────────
 *
 * WhatsApp delivers a free-form message only within 24 hours of the contact's
 * last message. Outside that, an approved TEMPLATE is the only thing it
 * accepts. Every one of ADM-11's follow-up days — 2, 5, 8, 11, 14, 17, 20 and
 * 7, 14, 21, 28, 35, 42, 49 — is outside it, and so is every one of the twelve
 * hundred historical leads, who last wrote months ago.
 *
 * ── what this function does NOT decide ────────────────────────────────────
 *
 * The body. A template's text is approved at Meta and lives there; this sends
 * a NAME, a LANGUAGE and positional parameters. That is the whole reason it
 * can be sent outside the window and free text cannot — somebody at Meta read
 * it first.
 *
 * So a caller cannot use this to say something new. It can only invoke
 * something already approved, which is the property that makes it safe to run
 * unattended against a list of twelve hundred people.
 */
export async function sendWhatsAppTemplate(input: {
  phoneNumberId: string;
  to: string;
  templateName: string;
  languageCode: string;
  /** Fills the approved body's {{1}}, {{2}} … in order. Empty is the commonest case. */
  parameters?: readonly string[];
  recipientType?: 'individual' | 'group';
}): Promise<SendResult> {
  const env = serverEnv();

  if (!env.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, permanent: false, message: 'WhatsApp sending is not configured on this deployment.' };
  }
  if (!input.phoneNumberId) {
    return { ok: false, permanent: true, message: 'This organization has no WhatsApp number configured, so nothing can be sent from it.' };
  }
  if (!input.templateName.trim() || !input.languageCode.trim()) {
    // Permanent: a retry sends the same empty name. Somebody has to register
    // the template, and until they do this situation should send nothing.
    return { ok: false, permanent: true, message: 'No approved template is registered for this situation.' };
  }

  const base = env.WHATSAPP_GRAPH_BASE_URL ?? DEFAULT_BASE;
  const parameters = input.parameters ?? [];

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
        type: 'template',
        template: {
          name: input.templateName,
          language: { code: input.languageCode },
          // Omitted entirely when there are none: Meta refuses an empty
          // components array on a template that declares no variables, which
          // is the commonest kind and would otherwise fail for every agency
          // that registered the simplest thing that works.
          ...(parameters.length > 0
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: parameters.map((text) => ({ type: 'text', text })),
                  },
                ],
              }
            : {}),
        },
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown';
    console.error(JSON.stringify({ level: 'error', scope: 'sendWhatsAppTemplate', detail }));
    return { ok: false, permanent: false, message: 'WhatsApp could not be reached.' };
  }

  const text = await response.text();

  if (!response.ok) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'sendWhatsAppTemplate',
        status: response.status,
        template: input.templateName,
        detail: text.slice(0, 500),
      }),
    );
    return {
      ok: false,
      // The text sender's rule, restated identically rather than paraphrased:
      // a 4xx that is not 429 is the provider saying no to this request, and a
      // retry sends the same no.
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
      message: `WhatsApp refused the template (${response.status}).`,
    };
  }

  // Same reconciliation rule the text sender applies: a 200 carrying no
  // message id is not a success anybody can match a delivery receipt to.
  let providerRef: string | undefined;
  try {
    providerRef = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id;
  } catch {
    providerRef = undefined;
  }
  if (!providerRef) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'sendWhatsAppTemplate',
        detail: `accepted with no message id: ${text.slice(0, 200)}`,
      }),
    );
    return { ok: false, permanent: false, message: 'WhatsApp accepted the template without identifying it.' };
  }

  return { ok: true, providerRef };
}
