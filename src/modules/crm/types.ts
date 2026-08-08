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

export type ConversationMessage = Pick<
  MessageRow,
  'id' | 'seq' | 'author_type' | 'body' | 'occurred_at'
>;

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
