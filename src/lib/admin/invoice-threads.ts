import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { listClientLeads } from './client-leads';
import { listClientLeadThreads } from './client-threads';

/**
 * SCR-051, owner decision 2026-09-29 — the WhatsApp threads an invoice can
 * be sent on from the invoice page: the client account's own thread, the
 * project's group, and the client's lead threads. The picker only; the door
 * (`sendInvoiceWhatsApp`) checks again that the chosen thread belongs to the
 * client, and then consent and the window decide per thread.
 */
export type InvoiceThread = {
  conversationId: string;
  kind: string;
  label: string;
};

export async function listInvoiceThreads(invoice: {
  client_account_id: string;
  project_id: string | null;
}): Promise<InvoiceThread[]> {
  const supabase = await createClient();

  const filters = [`client_account_id.eq.${invoice.client_account_id}`];
  if (invoice.project_id) filters.push(`project_id.eq.${invoice.project_id}`);

  const { data, error } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, kind, title, channel, status, updated_at')
    .in('kind', ['client_account', 'project_group'])
    .or(filters.join(','))
    .neq('status', 'abandoned')
    .order('updated_at', { ascending: false });
  if (error) unreadable('listInvoiceThreads', error);

  const own: InvoiceThread[] = (data ?? []).map((c) => ({
    conversationId: c.id,
    kind: c.kind,
    label: `${c.kind === 'client_account' ? 'Client thread' : 'Project group'}${c.title ? ` · ${c.title}` : ''} (${c.channel})`,
  }));

  const leads = await listClientLeads(invoice.client_account_id);
  const leadThreads = await listClientLeadThreads(leads.map((l) => l.id));
  const fromLeads: InvoiceThread[] = leadThreads.map((t) => {
    const lead = leads.find((l) => l.id === t.leadId);
    return {
      conversationId: t.conversationId,
      kind: t.kind,
      label: `Lead · ${lead?.title ?? t.leadId.slice(0, 8)}${t.title ? ` · ${t.title}` : ''} (${t.channel})`,
    };
  });

  return [...own, ...fromLeads];
}
