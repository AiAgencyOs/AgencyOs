import type { Database } from '@/lib/db/types';

type LeadRow = Database['crm']['Tables']['leads']['Row'];

/**
 * A lead as the pipeline list renders it.
 *
 * Derived from the generated row type rather than restated, so a column rename
 * in a migration breaks the build here instead of silently rendering blanks.
 * Only the columns the list actually shows are carried — a list view has no
 * business shipping `requirements` to the client. (`score` and
 * `score_reasons` are gone entirely: ADM-88 declined a lead score, and
 * `crm.leads` now refuses to hold one.)
 */
export type LeadListItem = Pick<
  LeadRow,
  'id' | 'title' | 'status' | 'source' | 'created_at'
> & {
  contact: { fullName: string; company: string | null } | null;
};

/** Lead header shown above a requirement-collection conversation. */
export type LeadHeader = Pick<LeadRow, 'id' | 'title' | 'status' | 'source' | 'summary'>;

type ConversationRow = Database['crm']['Tables']['conversations']['Row'];
type MessageRow = Database['crm']['Tables']['conversation_messages']['Row'];
type RequirementVersionRow = Database['crm']['Tables']['requirement_versions']['Row'];

export type Conversation = Pick<
  ConversationRow,
  'id' | 'lead_id' | 'contact_id' | 'channel' | 'status' | 'created_at'
>;

/**
 * Whether WE got the message out: `pending` when written, `sent` when the
 * provider accepted it, `failed` when it did not. Null for an inbound message,
 * which has no send state of its own.
 *
 * This is the ACCEPT axis and it stops at "the provider took it". What
 * happened afterwards is `MessageWireStatus`, deliberately kept separate —
 * see the note there.
 */
export type MessageDelivery = 'pending' | 'sent' | 'failed' | null;

/**
 * What Meta reported *afterwards*, from its status callbacks.
 *
 * A second axis, not an overload of the first, for the reason migration
 * `…140000_a_message_reports_what_the_wire_did` gives:
 *
 *   "A message can be delivery=sent (we handed it off) and wire_status=failed
 *    (Meta later said it bounced), and reading both is the point —
 *    collapsing them would hide exactly the case that matters."
 *
 * Monotonic on the database side: sent(1) < delivered(2) < read(3), with
 * `read` and `failed` terminal, so an out-of-order receipt never regresses it.
 * Null when no receipt has arrived — which is different from "not delivered",
 * and the transcript says so.
 */
export type MessageWireStatus = 'sent' | 'delivered' | 'read' | 'failed' | null;

/**
 * What kind of thing arrived, when it was not text.
 *
 * Null for a text message, which is what `body` is for. The pair is exclusive:
 * a media row has a kind and an empty body, and the transcript renders the
 * envelope rather than pretending to know the letter.
 */
export type MessageMediaKind =
  | 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'location' | null;

export type ConversationMessage = Pick<
  MessageRow,
  'id' | 'seq' | 'author_type' | 'body' | 'occurred_at' | 'media_description'
> & {
  /** 'outbound' for a message AgencyOS sent, 'inbound' for one it received, null if unstated. */
  direction: 'inbound' | 'outbound' | null;
  /** The send state, for an outbound message. Null for inbound. */
  delivery: MessageDelivery;
  /** What Meta said happened next. Null until a receipt arrives. */
  wire: MessageWireStatus;
  /** The kind of a non-text message. Null for text. */
  mediaKind: MessageMediaKind;
  /** The client's own words beside the file, when they typed any. */
  caption: string | null;
  /** Meta's handle for the file. Not rendered; present so a reader knows one exists. */
  mediaId: string | null;
};

/**
 * Reads direction and delivery out of a message's metadata jsonb, defensively.
 *
 * Pure and exported so the one place that interprets the metadata shape is
 * tested directly rather than inferred from a rendered page. An unrecognised
 * value becomes null rather than being shown as a state that does not exist.
 */
export function deliveryOf(metadata: unknown): {
  direction: 'inbound' | 'outbound' | null;
  delivery: MessageDelivery;
  wire: MessageWireStatus;
  mediaKind: MessageMediaKind;
  /** The client's own words beside the file, when they typed any. */
  caption: string | null;
  /** Meta's handle for the file — present only when there is one to fetch. */
  mediaId: string | null;
} {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const direction = m.direction === 'inbound' || m.direction === 'outbound' ? m.direction : null;
  const raw = m.delivery;
  const delivery: MessageDelivery =
    raw === 'pending' || raw === 'sent' || raw === 'failed' ? raw : null;

  const rawWire = m.wire_status;
  const wire: MessageWireStatus =
    rawWire === 'sent' || rawWire === 'delivered' || rawWire === 'read' || rawWire === 'failed'
      ? rawWire
      : null;

  // Both axes only mean something for an outbound message. A receipt cannot
  // stamp wire state onto a client's own words — the database enforces that
  // too, by scoping the update to an outbound row.
  const rawMedia = m.media_type;
  const KINDS = ['audio', 'image', 'video', 'document', 'sticker', 'location'];
  const mediaKind: MessageMediaKind =
    typeof rawMedia === 'string' && KINDS.includes(rawMedia)
      ? (rawMedia as MessageMediaKind)
      : null;

  const rawCaption = m.caption;
  const caption =
    typeof rawCaption === 'string' && rawCaption.trim() !== '' ? rawCaption.trim() : null;

  const rawMediaId = m.media_id;
  const mediaId =
    typeof rawMediaId === 'string' && rawMediaId.trim() !== '' ? rawMediaId.trim() : null;

  const outbound = direction === 'outbound';
  return {
    direction,
    delivery: outbound ? delivery : null,
    wire: outbound ? wire : null,
    // Unlike the two above, this is true of a message in either direction.
    mediaKind,
    caption,
    mediaId,
  };
}

/** What each kind of media is called when it has to be named in a sentence. */
const MEDIA_NOUN: Record<Exclude<MessageMediaKind, null>, string> = {
  audio: 'voice note',
  image: 'photo',
  video: 'video',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
};

/**
 * What one message contributes to a transcript a model reads — or nothing.
 *
 * Recording media gave `crm.conversation_messages` its first rows with an
 * empty `body`, and the transcript builder passed `body` straight through as
 * message content. An empty content block is not a smaller input; it is a
 * malformed request, and the provider rejects the whole call. Extraction is
 * not queued *for* a media message, which hid this: the break needs a voice
 * note and then a text message, at which point the text queues an extraction
 * whose transcript contains the silent row.
 *
 * A named placeholder rather than a dropped row, because the two say different
 * things. Dropping it tells the model the client said nothing between two
 * turns; `[voice note — not transcribed]` tells it something arrived that
 * nobody has read yet, which is the truth and is worth knowing when the model
 * is deciding whether it has enough to summarise. It is a description of the
 * envelope, not words put in a client's mouth — the same line the transcript
 * on screen already draws.
 *
 * Returns null only for a row that is empty *and* unexplained, which no
 * ingest path produces and the body check constraint forbids. If one ever
 * exists, it contributes nothing rather than breaking the request.
 *
 * ── and what happens once somebody HAS read it ───────────────────────────
 *
 * §28 of the owner's brief states the rule in both directions: *"Do not say
 * 'Not transcribed' if the system actually has the capability to inspect the
 * image"*, and *"If image understanding is unavailable: do not pretend."*
 *
 * Both are held by one fact rather than by two rules. The line is built from
 * whether a description EXISTS — so it cannot claim a reading that did not
 * happen, and it cannot withhold one that did. There is nothing here to keep
 * in step with anything, which is why it is a `??` and not a branch.
 *
 * The description is labelled as a reading, never merged into the client's
 * words. `Client: [photo, read by the agent: …]` is true; `Client: a login
 * screen with a blue button` would be this system putting a sentence in
 * somebody's mouth, and a later reader would have no way to tell.
 */
export function transcriptContent(
  body: string | null,
  mediaKind: MessageMediaKind,
  media?: { description?: string | null; caption?: string | null },
): string | null {
  const text = (body ?? '').trim();
  if (text !== '') return text;
  if (!mediaKind) return null;

  const noun = MEDIA_NOUN[mediaKind];
  // The caption is the one part of a media message that IS the client's own
  // words, so it is quoted rather than paraphrased, and it is shown whether or
  // not the file itself could be read.
  const caption = (media?.caption ?? '').trim();
  const captioned = caption === '' ? noun : `${noun}, captioned “${caption}”`;

  const description = (media?.description ?? '').trim();
  return description === ''
    ? `[${captioned} — not transcribed]`
    : `[${captioned} — read by the agent: ${description}]`;
}

/** How each author is named in the transcript the model reads. */
const AUTHOR_LABEL: Record<string, string> = {
  client: 'Client',
  user: 'Staff',
  agent: 'Agent',
  system: 'System',
};

/**
 * The whole conversation, as one labelled document.
 *
 * It used to be mapped turn-for-turn onto the model's own dialogue — client to
 * `user`, everyone else to `assistant` — and that shape failed on production
 * twice for the same underlying reason: it claims the transcript is a
 * conversation the model took part in, and the API then applies its rules for
 * one. A conversation that ends on a staff message ends on an `assistant` turn,
 * which is a **prefill**, and this model refuses it: *"the conversation must
 * end with a user message"*. The mirror case is a conversation that opens with
 * staff.
 *
 * Neither is a real constraint on a sales thread. They are constraints on a
 * dialogue, and this is not one — it is material to read. Handing it over as a
 * single labelled document removes that entire class of failure rather than
 * patching the ends of it, and it stops telling the model it wrote the staff
 * replies, which it did not: the auto-responder's *"I'll reply as soon as I
 * finish making someone famous online"* is not something the extractor said.
 *
 * Who spoke is not lost, it is stated — `Client:` and `Staff:` rather than
 * implied by a role, which is more legible and not less.
 */
export function transcriptForModel(
  rows: ReadonlyArray<{
    author_type: string;
    body: string | null;
    metadata: unknown;
    /**
     * Required rather than optional, so a caller that forgets to select it
     * fails to compile rather than silently handing the model a transcript in
     * which every image reads as unread. That is the half-a-check shape: a
     * rule held in two places and exercised through one.
     */
    media_description: string | null;
  }>,
): string {
  return rows
    .map((row) => {
      const media = deliveryOf(row.metadata);
      const content = transcriptContent(row.body, media.mediaKind, {
        description: row.media_description,
        caption: media.caption,
      });
      if (content === null) return null;
      // An unrecognised author_type is labelled by its own name rather than
      // guessed at: the CHECK admits four, and inventing a fifth's job title
      // would put a claim in front of the model that nothing supports.
      return `${AUTHOR_LABEL[row.author_type] ?? row.author_type}: ${content}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * One extracted requirement set. `payload` stays `unknown` at this boundary:
 * it is jsonb in the database and only becomes a RequirementPayload after
 * requirementPayloadSchema validates it, which is what stops unvalidated model
 * output from reaching a caller (ARCHITECTURE.md §6.6).
 */
export type RequirementVersion = Pick<
  RequirementVersionRow,
  'id' | 'version' | 'source' | 'status' | 'created_at' | 'generated_by_run_id'
> & { payload: unknown };

/** Lead pipeline state, as the sales panel renders it. */
export type LeadPipeline = Pick<
  LeadRow,
  'id' | 'status' | 'next_follow_up_at' | 'disqualified_reason' | 'converted_at'
> & { qualification: unknown };

type ActivityRow = Database['crm']['Tables']['lead_activities']['Row'];

export type LeadActivity = Pick<
  ActivityRow,
  'id' | 'kind' | 'body' | 'actor_type' | 'occurred_at'
>;

/** A row of the portfolio list (G-013, ADM-12). */
export type PortfolioItemRow = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  url: string;
  is_active: boolean;
  position: number;
  created_at: string;
};

