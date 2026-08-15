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
 * How far an outbound message got. Read from the message's metadata rather
 * than a column, because that is where the send path records it: `pending`
 * when written, `sent` when the provider accepted it, `failed` when it did
 * not. Null for an inbound message, which has no send state of its own.
 *
 * "sent" is the honest ceiling of what this system knows on its own — the
 * provider ACCEPTED the message. Whether WhatsApp then delivered it to the
 * recipient is a separate fact only Meta's status callbacks carry, and those
 * are not yet ingested; a `delivered`/`read` state would be added here when
 * they are.
 */
export type MessageDelivery = 'pending' | 'sent' | 'failed' | null;

export type ConversationMessage = Pick<
  MessageRow,
  'id' | 'seq' | 'author_type' | 'body' | 'occurred_at'
> & {
  /** 'outbound' for a message AgencyOS sent, 'inbound' for one it received, null if unstated. */
  direction: 'inbound' | 'outbound' | null;
  /** The send state, for an outbound message. Null for inbound. */
  delivery: MessageDelivery;
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
} {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const direction = m.direction === 'inbound' || m.direction === 'outbound' ? m.direction : null;
  const raw = m.delivery;
  const delivery: MessageDelivery =
    raw === 'pending' || raw === 'sent' || raw === 'failed' ? raw : null;
  // Delivery state only means something for an outbound message.
  return { direction, delivery: direction === 'outbound' ? delivery : null };
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

