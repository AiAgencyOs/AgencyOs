import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What the Client Management screen shows beyond the table: the phone number
 * of each client (a client account has none of its own; its people do, in
 * `crm.contacts.client_account_id`, so the first contact's number is used),
 * the projects of the selected client, and the bottom row - the latest
 * client messages, the next lead follow-ups and the invoices still owed. Every
 * read is an RLS-scoped select on the owning tables; a failed read throws
 * (`unreadable`), it never renders as an empty card.
 */

export type ClientsOverview = {
  phoneByClient: Map<string, string>;
  recentMessages: { id: string; clientId: string; body: string; at: string; direction: 'inbound' | 'outbound' | null }[];
  followUps: { leadId: string; leadTitle: string; clientId: string; at: string }[];
  pendingInvoices: { id: string; number: string; clientId: string; dueAt: string | null; owedMinor: number; currency: string; status: string }[];
};

export async function getClientsOverview(want: { leads: boolean; invoices: boolean }): Promise<ClientsOverview> {
  const supabase = await createClient();

  const contactsRes = await supabase
    .schema('crm')
    .from('contacts')
    .select('id, client_account_id, phone')
    .not('client_account_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (contactsRes.error) unreadable('getClientsOverview.contacts', contactsRes.error);
  const contacts = contactsRes.data ?? [];

  const phoneByClient = new Map<string, string>();
  const clientOfContact = new Map<string, string>();
  for (const c of contacts) {
    if (!c.client_account_id) continue;
    clientOfContact.set(c.id, c.client_account_id);
    if (c.phone && !phoneByClient.has(c.client_account_id)) phoneByClient.set(c.client_account_id, c.phone);
  }

  const contactIds = [...clientOfContact.keys()];
  const [convRes, leadRes, invRes] = await Promise.all([
    want.leads
      ? supabase.schema('crm').from('conversations').select('id, client_account_id').not('client_account_id', 'is', null).limit(500)
      : Promise.resolve({ data: [], error: null }),
    want.leads && contactIds.length > 0
      ? supabase
          .schema('crm')
          .from('leads')
          .select('id, title, contact_id, next_follow_up_at')
          .in('contact_id', contactIds.slice(0, 1000))
          .is('deleted_at', null)
          .not('next_follow_up_at', 'is', null)
          .gte('next_follow_up_at', new Date().toISOString())
          .order('next_follow_up_at', { ascending: true })
          .limit(5)
      : Promise.resolve({ data: [], error: null }),
    want.invoices
      ? supabase
          .schema('finance')
          .from('invoices')
          .select('id, number, client_account_id, due_at, total_minor, paid_minor, currency, status')
          .in('status', ['issued', 'partially_paid', 'overdue'])
          .order('due_at', { ascending: true, nullsFirst: false })
          .limit(5)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (convRes.error) unreadable('getClientsOverview.conversations', convRes.error);
  if (leadRes.error) unreadable('getClientsOverview.leads', leadRes.error);
  if (invRes.error) unreadable('getClientsOverview.invoices', invRes.error);

  const clientOfConversation = new Map((convRes.data ?? []).map((c) => [c.id, c.client_account_id as string]));
  const convIds = [...clientOfConversation.keys()];
  const msgRes =
    convIds.length > 0
      ? await supabase
          .schema('crm')
          .from('conversation_messages')
          .select('id, conversation_id, body, occurred_at, metadata')
          .in('conversation_id', convIds)
          .order('occurred_at', { ascending: false })
          .limit(5)
      : { data: [], error: null };
  if (msgRes.error) unreadable('getClientsOverview.messages', msgRes.error);

  return {
    phoneByClient,
    recentMessages: (msgRes.data ?? []).map((m) => {
      const dir = (m.metadata as { direction?: string } | null)?.direction;
      return { id: m.id, clientId: clientOfConversation.get(m.conversation_id) ?? '', body: m.body, at: m.occurred_at, direction: dir === 'inbound' || dir === 'outbound' ? dir : null };
    }),
    followUps: (leadRes.data ?? []).map((l) => ({ leadId: l.id, leadTitle: l.title, clientId: clientOfContact.get(l.contact_id ?? '') ?? '', at: l.next_follow_up_at as string })),
    pendingInvoices: (invRes.data ?? []).map((i) => ({ id: i.id, number: i.number, clientId: i.client_account_id, dueAt: i.due_at, owedMinor: i.total_minor - i.paid_minor, currency: i.currency, status: i.status })),
  };
}

export async function listClientProjectsBrief(clientId: string): Promise<{ id: string; name: string; status: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, status')
    .eq('client_account_id', clientId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(6);
  if (error) unreadable('listClientProjectsBrief', error);
  return data ?? [];
}
