import 'server-only';

import { createClient } from '@/lib/db/server';

import type {
  Conversation,
  ConversationMessage,
  LeadHeader,
  LeadListItem,
  RequirementVersion,
} from './types';

/**
 * Reads for the crm module. Pure, RLS-scoped, safe in Server Components
 * (ARCHITECTURE.md §3.2).
 *
 * These use the per-request client, which carries the user's JWT, so the
 * database applies the same tenant isolation to our own server code that it
 * applies to anyone else. There is deliberately no organization_id filter
 * below: adding one would imply the isolation lives here, and the day someone
 * forgets it the query would still be safe only by accident. RLS is the
 * boundary; this file is just a projection.
 */

const LIST_SELECT = 'id, title, status, score, source, created_at, contacts(full_name, company)';

export async function listLeads(limit = 100): Promise<LeadListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select(LIST_SELECT)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'listLeads', detail: error.message }));
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    score: row.score,
    source: row.source,
    created_at: row.created_at,
    contact: row.contacts
      ? { fullName: row.contacts.full_name, company: row.contacts.company }
      : null,
  }));
}

// ── Requirement collection ────────────────────────────────────────────────

export async function getLeadHeader(leadId: string): Promise<LeadHeader | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, title, status, source, summary')
    .eq('id', leadId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'getLeadHeader', detail: error.message }));
    return null;
  }
  return data;
}

/**
 * The newest conversation for a lead, or null.
 *
 * One active thread per lead is all requirement collection needs today. The
 * table permits many, so supporting several later is a query change rather
 * than a migration.
 */
export async function getLatestConversation(leadId: string): Promise<Conversation | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, lead_id, contact_id, channel, status, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'getLatestConversation', detail: error.message }),
    );
    return null;
  }
  return data;
}

export async function listMessages(conversationId: string): Promise<ConversationMessage[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('id, seq, author_type, body, occurred_at')
    .eq('conversation_id', conversationId)
    .order('seq', { ascending: true });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'listMessages', detail: error.message }));
    return [];
  }
  return data ?? [];
}

export async function listRequirementVersions(
  conversationId: string,
): Promise<RequirementVersion[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('requirement_versions')
    .select('id, version, source, status, created_at, generated_by_run_id, payload')
    .eq('conversation_id', conversationId)
    .order('version', { ascending: false });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'listRequirementVersions', detail: error.message }),
    );
    return [];
  }
  return data ?? [];
}
