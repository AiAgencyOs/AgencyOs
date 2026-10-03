import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-017 — the lead threads a client can be written to from Client 360.
 *
 * Sending lives on the lead thread (`sendClientMessage` takes a
 * conversation); the client page only offers the picker. Every non-abandoned
 * conversation on one of the client's leads is a candidate — the door then
 * decides, per thread, whether the 24-hour window is open and consent is
 * recorded, and says so if not.
 */
export type ClientLeadThread = {
  conversationId: string;
  leadId: string;
  title: string | null;
  channel: string;
  kind: string;
  status: string;
  updatedAt: string;
};

export async function listClientLeadThreads(leadIds: readonly string[]): Promise<ClientLeadThread[]> {
  if (leadIds.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, lead_id, title, channel, kind, status, updated_at')
    .in('lead_id', [...leadIds])
    .neq('status', 'abandoned')
    .order('updated_at', { ascending: false });
  if (error) unreadable('listClientLeadThreads', error);

  return (data ?? [])
    .filter((c) => c.lead_id !== null)
    .map((c) => ({
      conversationId: c.id,
      leadId: c.lead_id as string,
      title: c.title,
      channel: c.channel,
      kind: c.kind,
      status: c.status,
      updatedAt: c.updated_at,
    }));
}
