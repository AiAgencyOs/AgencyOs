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
  MeetingChainLink,
  MeetingDetail,
  MeetingEvidenceItem,
  MeetingJob,
  MeetingListItem,
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
    .select('id, lead_id, contact_id, channel, status, created_at, agent_paused_at, agent_paused_reason')
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
    .select('id, seq, author_type, body, occurred_at, metadata, media_description')
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
    .select('id, version, source, status, created_at, generated_by_run_id, payload, sent_for_confirmation_at')
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


/**
 * Who needs a person first — Document 09 §31, under ADM-88.
 *
 * Read through `crm.lead_attention`, which owns the tier order and the tenant
 * pin. Nothing is decided here: a second copy of the ordering would be a
 * second thing to keep in step, and this page would be where the two first
 * disagreed.
 *
 * Refuses on failure rather than returning an empty list (G-054). "Nobody
 * needs you" is the single most dangerous thing this surface could say when
 * the database did not answer.
 */
export type LeadAttention = {
  lead_id: string;
  title: string;
  status: string;
  reason: string;
  waiting_since: string | null;
};

export async function listLeadsNeedingAttention(limit = 8): Promise<LeadAttention[]> {
  const supabase = await createClient();

  const { data, error } = await supabase.schema('crm').rpc('lead_attention', { p_limit: limit });

  if (error) unreadable('listLeadsNeedingAttention', error);
  return data ?? [];
}

// ── Meetings (A08/A09, G-234) ───────────────────────────────────────────────
//
// Reads only. Every writer a screen would need is named as BLOCKED on the
// screen itself (see meetings-view.ts); nothing here changes a row.

const MEETING_COLUMNS =
  'id, lead_id, contact_id, opportunity_id, status, requested_mode, booked_mode, requested_start_at, requested_window_end, ' +
  'confirmed_start_at, confirmed_end_at, timezone, provider, provider_event_id, meeting_url, availability_source, ' +
  'availability_read_at, booked_at, cancelled_at, cancellation_reason, completed_at, completed_by, outcome, supersedes_id, purpose, created_at';
// `leads!inner`: every meeting has a lead (lead_id is NOT NULL), so the inner
// embed drops nothing on its own — and it is what lets `leads.assigned_to`
// filter the parent rows (PostgREST filters an embedded resource only with
// an inner join). One literal select, so the client's row typing holds.
const MEETING_LIST_SELECT = `${MEETING_COLUMNS}, leads!inner(title, assigned_to), contacts(full_name)`;

export type MeetingListFilter = {
  from: Date;
  to: Date;
  status?: string;
  mode?: string;
  /** The lead's assignee — the nearest thing a meeting has to an owner; crm.meetings carries none of its own. */
  owner?: string;
  /** Newest first, for a window in the past: the bound then keeps the most recent rather than the oldest. */
  newestFirst?: boolean;
  limit?: number;
};

/**
 * The calendar's rows: meetings whose agreed time — or, when nothing is
 * agreed yet, requested time — falls in the window. Bounded (Blueprint §12:
 * "server-side pagination for operational lists"), and the page says when the
 * bound was hit rather than pretending the window was fully shown.
 */
export async function listMeetings(filter: MeetingListFilter): Promise<MeetingListItem[]> {
  const supabase = await createClient();
  const from = filter.from.toISOString();
  const to = filter.to.toISOString();

  const ascending = !filter.newestFirst;
  let query = supabase
    .schema('crm')
    .from('meetings')
    .select(MEETING_LIST_SELECT)
    // Values are double-quoted: PostgREST's `or=` grammar splits on dots and
    // commas, and an ISO instant carries both a dot and a colon.
    .or(
      `and(confirmed_start_at.gte."${from}",confirmed_start_at.lt."${to}"),` +
        `and(confirmed_start_at.is.null,requested_start_at.gte."${from}",requested_start_at.lt."${to}")`,
    )
    // Agreed times first (nulls last), then requested ones: the bound cuts
    // request-only rows before agreed ones, and the page says exactly that.
    .order('confirmed_start_at', { ascending, nullsFirst: false })
    .order('requested_start_at', { ascending, nullsFirst: false })
    .limit(Math.min(filter.limit ?? 200, 200));
  if (filter.status) query = query.eq('status', filter.status);
  if (filter.owner) query = query.eq('leads.assigned_to', filter.owner);
  if (filter.mode) query = query.or(`booked_mode.eq.${filter.mode},and(booked_mode.is.null,requested_mode.eq.${filter.mode})`);

  const { data, error } = await query;
  if (error) unreadable('listMeetings', error);

  return (data ?? []).map((row) => ({
    ...row,
    lead: row.leads ? { title: row.leads.title, assigned_to: row.leads.assigned_to } : null,
    contact: row.contacts ? { full_name: row.contacts.full_name } : null,
  }));
}

/** Meetings on one lead, newest first — the lead page's card. */
export async function listMeetingsForLead(leadId: string, limit = 20): Promise<MeetingListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('meetings')
    .select(MEETING_LIST_SELECT)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listMeetingsForLead', error);

  return (data ?? []).map((row) => ({
    ...row,
    lead: row.leads ? { title: row.leads.title, assigned_to: row.leads.assigned_to } : null,
    contact: row.contacts ? { full_name: row.contacts.full_name } : null,
  }));
}

/** One meeting, whole. Null is "not found" or "not your tenant" — RLS does not distinguish, and neither does the page. */
export async function getMeeting(meetingId: string): Promise<MeetingDetail | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('meetings')
    .select('*, leads(title, assigned_to, status), contacts(full_name)')
    .eq('id', meetingId)
    .maybeSingle();

  if (error) unreadable('getMeeting', error);
  // A missing row is the answer `data` already is; only the shape is added.
  return data ? shapeMeetingDetail(data) : data;
}

function shapeMeetingDetail(data: {
  leads: { title: string; assigned_to: string | null; status: string } | null;
  contacts: { full_name: string } | null;
} & Omit<MeetingDetail, 'lead' | 'contact'>): MeetingDetail {
  const { leads, contacts, ...row } = data;
  return {
    ...row,
    lead: leads ? { title: leads.title, assigned_to: leads.assigned_to, status: leads.status } : null,
    contact: contacts ? { full_name: contacts.full_name } : null,
  };
}

/** Evidence attached to a meeting — references and notes, newest first (G-229). */
export async function listMeetingEvidence(meetingId: string): Promise<MeetingEvidenceItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('meeting_evidence')
    .select('id, kind, visibility, artifact_ref, body, media_type, byte_size, uploaded_by, uploaded_at')
    .eq('meeting_id', meetingId)
    .order('uploaded_at', { ascending: false });

  if (error) unreadable('listMeetingEvidence', error);
  return data ?? [];
}

/**
 * The reminder and analysis jobs that name this meeting. Read from
 * core.jobs by payload, which is how G-228 and G-229 key them; the screen
 * says what a queued row means in a deployment with no worker for the kind.
 */
export async function listMeetingJobs(meetingId: string): Promise<MeetingJob[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('jobs')
    .select('id, kind, status, run_at, attempts, last_error, created_at')
    .in('kind', ['meeting.reminder', 'meeting.analysis'])
    .filter('payload->>meeting_id', 'eq', meetingId)
    .order('created_at', { ascending: false });

  if (error) unreadable('listMeetingJobs', error);
  return data ?? [];
}

/** The same, for a whole calendar page in one read; each job says which meeting it names. */
export async function listJobsForMeetings(meetingIds: readonly string[]): Promise<(MeetingJob & { meetingId: string })[]> {
  if (meetingIds.length === 0) return [];
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('jobs')
    .select('id, kind, status, run_at, attempts, last_error, created_at, payload')
    .in('kind', ['meeting.reminder', 'meeting.analysis'])
    .filter('payload->>meeting_id', 'in', `(${meetingIds.join(',')})`)
    .order('created_at', { ascending: false });

  if (error) unreadable('listJobsForMeetings', error);
  return (data ?? []).map(({ payload, ...job }) => ({
    ...job,
    meetingId: String((payload as { meeting_id?: unknown } | null)?.meeting_id ?? ''),
  }));
}

/**
 * The bookings this one replaced, oldest last — a reschedule mints a new row
 * carrying `supersedes_id` (G-225 §8), so the history is a chain, walked to a
 * bound. One read per link; a chain longer than the bound says so.
 */
export async function listMeetingChain(supersedesId: string | null, maxLinks = 10): Promise<{ links: MeetingChainLink[]; truncated: boolean }> {
  const supabase = await createClient();
  const links: MeetingChainLink[] = [];
  let next = supersedesId;

  while (next && links.length < maxLinks) {
    const { data, error } = await supabase
      .schema('crm')
      .from('meetings')
      .select('id, status, confirmed_start_at, requested_start_at, cancelled_at, cancellation_reason, created_at, supersedes_id')
      .eq('id', next)
      .maybeSingle();

    if (error) unreadable('listMeetingChain', error);
    if (!data) break;
    links.push(data);
    next = data.supersedes_id;
  }

  return { links, truncated: Boolean(next) && links.length >= maxLinks };
}
