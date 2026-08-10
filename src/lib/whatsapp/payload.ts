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
export type ParsedInboundMessage = {
  phoneNumberId: string;
  from: string;
  externalRef: string;
  body: string;
  profileName?: string;
  occurredAt?: string;
};

export type ParsedDelivery = {
  messages: ParsedInboundMessage[];
  /**
   * Events deliberately not acted on: status receipts, reactions, and message
   * types this slice does not read. Counted so the route's response says what
   * became of a delivery rather than silently reporting zero.
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
  let ignored = 0;

  if (!isRecord(payload)) return { messages, ignored };

  const envelope = payload as Envelope;
  if (envelope.object !== 'whatsapp_business_account') {
    return { messages, ignored };
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

      // Status receipts ride in the same change under `statuses`. They are the
      // most common delivery by volume and none of them is a message.
      ignored += asArray(value.statuses).length;

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

        // Only text is read. An image, audio note, reaction or location is a
        // real message but carries nothing this slice can extract requirements
        // from, and inventing a body for it would put words in a client's
        // mouth. Acknowledged and counted; a later step can widen this.
        if (message.type !== 'text' || !body || !from || !externalRef || !phoneNumberId) {
          ignored += 1;
          continue;
        }

        const profileName = names.get(from);
        const occurredAt = toIso(message.timestamp);

        messages.push({
          phoneNumberId,
          from,
          externalRef,
          body,
          ...(profileName ? { profileName } : {}),
          ...(occurredAt ? { occurredAt } : {}),
        });
      }
    }
  }

  return { messages, ignored };
}
