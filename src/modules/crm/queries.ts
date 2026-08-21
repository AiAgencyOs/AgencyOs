import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { deliveryOf } from './types';
import type {
  Conversation,
  ConversationMessage,
  LeadActivity,
  LeadHeader,
  LeadListItem,
  LeadPipeline,
  PortfolioItemRow,
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

const LIST_SELECT = 'id, title, status, source, created_at, contacts(full_name, company)';

export async function listLeads(limit = 100): Promise<LeadListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select(LIST_SELECT)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listLeads', error);

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
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

  if (error) unreadable('getLeadHeader', error);
  return data;
}

export type LeadReactivation = {
  /** Whether this lead is enrolled in the reactivation cohort right now. */
  inPilot: boolean;
  /**
   * Whether the lead COULD be enrolled — its contact holds a granted whatsapp
   * consent row. The database is the real gate (add_lead_to_reactivation_pilot
   * refuses `no_consent`); this only lets the screen say why before a click,
   * and is never treated as consent itself.
   */
  consentEligible: boolean;
};

/**
 * The reactivation state of one lead, for the owner-only cohort control on the
 * lead page. Two facts, read under RLS: is it enrolled, and is its contact
 * consent-eligible. A failed read is reported, never turned into a false
 * "not enrolled" — the G-054 reason the page holds: an empty answer would
 * invite an enrol click the database has no basis to accept.
 */
export async function getLeadReactivation(leadId: string): Promise<LeadReactivation> {
  const supabase = await createClient();

  const leadRead = await supabase
    .schema('crm')
    .from('leads')
    .select('in_reactivation_pilot, contact_id')
    .eq('id', leadId)
    .is('deleted_at', null)
    .maybeSingle();

  let error = leadRead.error;
  if (error) unreadable('getLeadReactivation', error);
  const lead = leadRead.data;
  if (!lead) return { inPilot: false, consentEligible: false };
  if (!lead.contact_id) return { inPilot: Boolean(lead.in_reactivation_pilot), consentEligible: false };

  const consentRead = await supabase
    .schema('crm')
    .from('communication_consent')
    .select('status')
    .eq('contact_id', lead.contact_id)
    .eq('channel', 'whatsapp')
    .eq('status', 'granted')
    .maybeSingle();

  error = consentRead.error;
  if (error) unreadable('getLeadReactivation', error);

  return { inPilot: Boolean(lead.in_reactivation_pilot), consentEligible: consentRead.data !== null };
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

  if (error) unreadable('getLatestConversation', error);
  return data;
}

export async function listMessages(conversationId: string): Promise<ConversationMessage[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('id, seq, author_type, body, occurred_at, metadata')
    .eq('conversation_id', conversationId)
    .order('seq', { ascending: true });

  if (error) unreadable('listMessages', error);
  return (data ?? []).map(({ metadata, ...row }) => ({ ...row, ...deliveryOf(metadata) }));
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

  if (error) unreadable('listRequirementVersions', error);
  return data ?? [];
}

// ── Lead pipeline ─────────────────────────────────────────────────────────

export async function getLeadPipeline(leadId: string): Promise<LeadPipeline | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, status, next_follow_up_at, disqualified_reason, converted_at, qualification')
    .eq('id', leadId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) unreadable('getLeadPipeline', error);
  return data;
}

export async function listLeadActivities(leadId: string, limit = 50): Promise<LeadActivity[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('lead_activities')
    .select('id, kind, body, actor_type, occurred_at')
    .eq('lead_id', leadId)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listLeadActivities', error);
  return data ?? [];
}

/**
 * The portfolio list, as the Admin maintains it — G-013, ADM-12.
 *
 * Everything, active and retired, because the screen that reads this is the
 * one that retires things. A caller that eventually *sends* from the list must
 * filter to `is_active` itself, and there is no such caller yet: that is
 * G-013 part 3, which waits on sales-agent activation under ADM-82's layer
 * gates — the consent gate it also needs now exists at
 * `crm.send_outbound_message` (G-012), and no ADM authorizes a human-triggered
 * send in its place.
 */
export async function listPortfolioItems(): Promise<PortfolioItemRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('portfolio_items')
    .select('id, kind, title, description, url, is_active, position, created_at')
    .order('kind', { ascending: true })
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) unreadable('listPortfolioItems', error);
  return data ?? [];
}

