import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What a high-risk setting would touch — SCR-071's "preview impact before
 * saving". Counts, from the same tables the change reaches, computed at
 * render so the form can show them BEFORE the person confirms:
 *
 *   timezone   every active follow-up sequence re-schedules in the new zone
 *              (`crm.follow_up_sequences.status = 'active'`), and every
 *              future meeting shows in it;
 *   name       every quotation PDF a client keeps from now on carries the new
 *              letterhead — the proposals not yet accepted are the ones a
 *              client will still open.
 *
 * A count that cannot be read refuses (G-054): a preview that said "0
 * affected" because the read failed would be the false calm this step
 * exists to remove.
 */

export type SettingImpact = {
  timezone: { activeFollowUps: number; upcomingMeetings: number };
  name: { openProposals: number; draftInvoices: number };
  /**
   * The commercial and outreach keys (SCR-071: "preview impact before saving
   * high-risk settings"). Counts of the quotations a change reaches, by where
   * they are in their life: `drafts` are not yet with a client and will be
   * drafted or re-checked under the new value; `withClients` are approved or
   * sent and keep what they were sent with.
   */
  quotations: { drafts: number; withClients: number };
  outreach: { activeFollowUps: number };
};

export async function readSettingImpact(): Promise<SettingImpact> {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const [followUps, meetings, proposals, invoices, drafts, withClients] = await Promise.all([
    supabase.schema('crm').from('follow_up_sequences').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.schema('crm').from('meetings').select('id', { count: 'exact', head: true }).gte('confirmed_start_at', nowIso),
    supabase.schema('sales').from('proposals').select('id', { count: 'exact', head: true }).in('status', ['draft', 'pending_approval', 'approved', 'sent']),
    supabase.schema('finance').from('invoices').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
    supabase.schema('sales').from('proposals').select('id', { count: 'exact', head: true }).in('status', ['draft', 'pending_approval']),
    supabase.schema('sales').from('proposals').select('id', { count: 'exact', head: true }).in('status', ['approved', 'sent']),
  ]);
  if (followUps.error) unreadable('readSettingImpact.followUps', followUps.error);
  if (meetings.error) unreadable('readSettingImpact.meetings', meetings.error);
  if (proposals.error) unreadable('readSettingImpact.proposals', proposals.error);
  if (invoices.error) unreadable('readSettingImpact.invoices', invoices.error);
  if (drafts.error) unreadable('readSettingImpact.drafts', drafts.error);
  if (withClients.error) unreadable('readSettingImpact.withClients', withClients.error);

  return {
    timezone: { activeFollowUps: followUps.count ?? 0, upcomingMeetings: meetings.count ?? 0 },
    name: { openProposals: proposals.count ?? 0, draftInvoices: invoices.count ?? 0 },
    quotations: { drafts: drafts.count ?? 0, withClients: withClients.count ?? 0 },
    outreach: { activeFollowUps: followUps.count ?? 0 },
  };
}
