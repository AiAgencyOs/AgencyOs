/**
 * The WhatsApp Cloud API delivery envelope, reduced to the messages this
 * project acts on.
 *
 * Separated from the route, and pure, for the same reason src/lib/events/
 * catalog.ts is separated from dispatch.ts: deciding *what arrived* is worth
 * testing directly, and it needs neither a database nor a signing key to do it.
 *
 * A single delivery can carry several business accounts, several changes, and
 * several messages, and most deliveries carry no message at all — status
 * receipts (sent/delivered/read) use the same envelope. Everything that is not
 * an inbound text message is counted and dropped here rather than reaching the
 * ingest, so the route can acknowledge it without pretending work happened.
 */

/** One inbound text message, in the shape modules/crm/ingest.ts accepts. */
/**
 * The non-text kinds this parser will carry. Bounded on purpose: `message.type`
 * is a provider's vocabulary, and an unrecognised value written into metadata
 * would surface, untranslated, on a screen somebody reads to understand a
 * client. Anything outside this list is counted as ignored, exactly as every
 * non-text message was before.
 */
export const MEDIA_KINDS = ['audio', 'image', 'video', 'document', 'sticker', 'location'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export type ParsedInboundMessage = {
  phoneNumberId: string;
  from: string;
  externalRef: string;
  body: string;
  profileName?: string;
  occurredAt?: string;
  /**
   * The provider's group id, when this arrived in a group — G-115.
   *
   * Meta delivers a group message carrying `group_id` in the message object,
   * with `from` still naming the individual participant who sent it. The two
   * are therefore distinguishable at the door, which matters more than it
   * sounds: `crm.ingest_whatsapp_message` would file a group message as a new
   * **lead** for whoever sent it, so a colleague saying "morning" in the
   * internal approval group would open a sales lead on themselves.
   *
   * Absent for a 1:1 thread, which is every message this system has handled
   * until now.
   */
  groupId?: string;
  /**
   * The kind of a non-text message — 'audio', 'image', 'video', 'document',
   * 'sticker', 'location'. Absent for text, which is what `body` is for.
   *
   * The two are exclusive by construction below: a media message carries a
   * kind and an empty body, a text message carries a body and no kind. That
   * keeps "we know what they said" and "we know only that they sent
   * something" apart at the door, rather than leaving a caller to infer it
   * from an empty string.
   */
  mediaType?: MediaKind;
};

/**
 * One delivery-status receipt — Meta reporting what the wire did to a message
 * we sent (C10). It rides in the same change under `value.statuses[]`, keyed by
 * `id` = the message id we stored as `provider_ref` when the send was accepted.
 *
 * `phoneNumberId` is our business number (the one an organization claims in
 * settings), so the receipt resolves to the same org an inbound message would.
 * `recipientId` is the client's wa_id, carried for observability only — the
 * message is found by `providerRef`, never by the recipient.
 */
export type ParsedStatusReceipt = {
  phoneNumberId: string;
  providerRef: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt?: string;
  recipientId?: string;
};

export type ParsedDelivery = {
  messages: ParsedInboundMessage[];
  /**
   * Delivery-status receipts (sent/delivered/read/failed) for messages we sent.
   * Previously counted as `ignored` and dropped; now surfaced so the route can
   * record the wire's answer against the message it names.
   */
  statuses: ParsedStatusReceipt[];
  /**
   * Events deliberately not acted on: reactions, message types this slice does
   * not read, and malformed status entries. Counted so the route's response
   * says what became of a delivery rather than silently reporting zero.
   */
  ignored: number;
};

/** The envelope Meta sends. Everything is optional because anything can be absent. */
type Envelope = {
  object?: unknown;
  entry?: unknown;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/**
 * Meta's timestamps are Unix **seconds**, as a string.
 *
 * Returned as an ISO string, or undefined when absent or unparseable — in which
 * case the database default (arrival time) stands. A message is never dropped
 * for having a timestamp we could not read.
 */
function toIso(value: unknown): string | undefined {
  const seconds = Number(asString(value));
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Reads a delivery.
 *
 * Never throws. A payload that is not the shape this expects yields no messages
 * rather than an exception, because the caller's alternative — a 500 — would
 * have Meta redeliver something that will never parse.
 *
 * `object` is checked: Meta sends `whatsapp_business_account` for this product,
 * and a delivery for anything else is not ours to interpret.
 */
export function parseDelivery(payload: unknown): ParsedDelivery {
  const messages: ParsedInboundMessage[] = [];
  const statuses: ParsedStatusReceipt[] = [];
  let ignored = 0;

  if (!isRecord(payload)) return { messages, statuses, ignored };

  const envelope = payload as Envelope;
  if (envelope.object !== 'whatsapp_business_account') {
    return { messages, statuses, ignored };
  }

  for (const entry of asArray(envelope.entry)) {
    if (!isRecord(entry)) continue;

    for (const change of asArray(entry.changes)) {
      if (!isRecord(change)) continue;

      // `field` names what changed. Only `messages` carries inbound traffic.
      if (change.field !== 'messages') {
        ignored += 1;
        continue;
      }

      const value = isRecord(change.value) ? change.value : null;
      if (!value) continue;

      const phoneNumberId = isRecord(value.metadata)
        ? asString(value.metadata.phone_number_id)
        : undefined;

      // Status receipts ride in the same change under `statuses` — the most
      // common delivery by volume. Each names a message we sent, by the id we
      // stored as provider_ref, and reports what the wire did to it (C10). A
      // well-formed one is surfaced; an entry missing its id, an unknown
      // status, or a delivery with no phone_number_id is counted ignored, the
      // same fate the message loop gives what it cannot act on.
      for (const status of asArray(value.statuses)) {
        if (!isRecord(status)) {
          ignored += 1;
          continue;
        }
        const providerRef = asString(status.id);
        const raw = asString(status.status);
        const wire =
          raw === 'sent' || raw === 'delivered' || raw === 'read' || raw === 'failed' ? raw : undefined;
        if (!providerRef || !wire || !phoneNumberId) {
          ignored += 1;
          continue;
        }
        const occurredAt = toIso(status.timestamp);
        const recipientId = asString(status.recipient_id);
        statuses.push({
          phoneNumberId,
          providerRef,
          status: wire,
          ...(occurredAt ? { occurredAt } : {}),
          ...(recipientId ? { recipientId } : {}),
        });
      }

      // profile names, keyed by the sender's wa_id.
      const names = new Map<string, string>();
      for (const contact of asArray(value.contacts)) {
        if (!isRecord(contact)) continue;
        const waId = asString(contact.wa_id);
        const name = isRecord(contact.profile) ? asString(contact.profile.name) : undefined;
        if (waId && name) names.set(waId, name);
      }

      for (const message of asArray(value.messages)) {
        if (!isRecord(message)) {
          ignored += 1;
          continue;
        }

        const from = asString(message.from);
        const externalRef = asString(message.id);
        const body = isRecord(message.text) ? asString(message.text.body) : undefined;

        if (!from || !externalRef || !phoneNumberId) {
          ignored += 1;
          continue;
        }

        // Text carries what they said. Everything else carries only the fact
        // that they said something — which is still a message, and dropping it
        // is how a conversation appears to stop while the client is waiting.
        //
        // A reaction is deliberately still dropped: it decorates a message
        // that is already in the transcript rather than being one, and filing
        // it as a separate entry would double-count a thumbs-up as a reply.
        const kind = asString(message.type);
        const isText = kind === 'text' && Boolean(body);
        const media = (MEDIA_KINDS as readonly string[]).includes(kind ?? '')
          ? (kind as MediaKind)
          : undefined;

        // A reaction decorates a message already in the transcript rather than
        // being one, and a status or system entry is not the client speaking —
        // both stay ignored, as every non-text message was before this.
        if (!isText && !media) {
          ignored += 1;
          continue;
        }

        const profileName = names.get(from);
        const occurredAt = toIso(message.timestamp);
        // G-115. Read from the message rather than the change, because one
        // delivery can carry both a group message and a 1:1 one.
        const groupId = asString(message.group_id);

        messages.push({
          phoneNumberId,
          from,
          externalRef,
          // Empty rather than invented: naming the envelope is not writing the
          // letter, and the transcript renders a media row from `mediaType`.
          body: body ?? '',
          ...(profileName ? { profileName } : {}),
          ...(occurredAt ? { occurredAt } : {}),
          ...(groupId ? { groupId } : {}),
          ...(media ? { mediaType: media } : {}),
        });
      }
    }
  }

  return { messages, statuses, ignored };
}
