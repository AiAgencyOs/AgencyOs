import type { Database } from '@/lib/db/types';

type LeadRow = Database['crm']['Tables']['leads']['Row'];

/**
 * A lead as the pipeline list renders it.
 *
 * Derived from the generated row type rather than restated, so a column rename
 * in a migration breaks the build here instead of silently rendering blanks.
 * Only the columns the list actually shows are carried — a list view has no
 * business shipping `requirements` or `score_reasons` to the client.
 */
export type LeadListItem = Pick<
  LeadRow,
  'id' | 'title' | 'status' | 'score' | 'source' | 'created_at'
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

export type ConversationMessage = Pick<
  MessageRow,
  'id' | 'seq' | 'author_type' | 'body' | 'occurred_at'
> & {
  /** 'outbound' for a message AgencyOS sent, 'inbound' for one it received, null if unstated. */
  direction: 'inbound' | 'outbound' | null;
  /** The send state, for an outbound message. Null for inbound. */
  delivery: MessageDelivery;
  /** What Meta said happened next. Null until a receipt arrives. */
  wire: MessageWireStatus;
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
  const outbound = direction === 'outbound';
  return { direction, delivery: outbound ? delivery : null, wire: outbound ? wire : null };
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
  'id' | 'status' | 'score' | 'next_follow_up_at' | 'disqualified_reason' | 'converted_at'
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

