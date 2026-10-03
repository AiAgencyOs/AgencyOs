import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Recent sales activity — SCR-005's third list. The newest rows of
 * `crm.lead_activities` across every lead the caller can read: a note, a
 * status change, a message either way, a call, an agent run, an
 * assignment — each a row somebody or something wrote, named by its lead.
 * Nothing is summarised here; the sentence is the row's own body.
 */
export type SalesActivity = {
  id: string;
  leadId: string;
  leadTitle: string;
  kind: string;
  body: string | null;
  occurredAt: string;
  actorType: string;
};

export async function listRecentSalesActivity(limit = 10): Promise<SalesActivity[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('lead_activities')
    .select('id, lead_id, kind, body, occurred_at, actor_type')
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listRecentSalesActivity', error);
  const rows = data ?? [];
  const leadIds = [...new Set(rows.map((r) => r.lead_id))];
  const titles = new Map<string, string>();
  if (leadIds.length > 0) {
    const { data: leads, error: leadsError } = await supabase.schema('crm').from('leads').select('id, title').in('id', leadIds);
    if (leadsError) unreadable('listRecentSalesActivity.leads', leadsError);
    for (const l of leads ?? []) titles.set(l.id, l.title);
  }
  return rows.map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    leadTitle: titles.get(r.lead_id) ?? 'Lead',
    kind: r.kind,
    body: r.body,
    occurredAt: r.occurred_at,
    actorType: r.actor_type,
  }));
}

/** Upcoming meetings — SCR-005: the next agreed or requested meetings from now, soonest first. */
export type UpcomingMeeting = { id: string; leadId: string; leadTitle: string; at: string; agreed: boolean; mode: string; status: string };

export async function listUpcomingMeetings(now: Date, limit = 6): Promise<UpcomingMeeting[]> {
  const supabase = await createClient();
  const iso = now.toISOString();
  const { data, error } = await supabase
    .schema('crm')
    .from('meetings')
    .select('id, lead_id, status, requested_mode, booked_mode, confirmed_start_at, requested_start_at, leads!inner(title)')
    .in('status', ['requested', 'booked'])
    .or(`confirmed_start_at.gte.${iso},and(confirmed_start_at.is.null,requested_start_at.gte.${iso})`)
    .limit(50);
  if (error) unreadable('listUpcomingMeetings', error);
  return (data ?? [])
    .map((m) => {
      const at = m.confirmed_start_at ?? m.requested_start_at;
      const lead = m.leads as unknown as { title: string } | null;
      return at ? { id: m.id, leadId: m.lead_id, leadTitle: lead?.title ?? 'Lead', at, agreed: m.confirmed_start_at !== null, mode: m.booked_mode ?? m.requested_mode, status: m.status } : null;
    })
    .filter((m): m is UpcomingMeeting => m !== null)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, limit);
}
