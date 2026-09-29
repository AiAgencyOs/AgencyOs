import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-011 — a quotation's delivery status, DERIVED from the outbound
 * message that carried it. `sales.proposals.sent_message_ref` is the id of
 * the `crm.conversation_messages` row the send wrote (sendProposal passes
 * `delivered.data.messageId`), and that row's metadata carries the provider
 * receipts (`wire_status`: sent → delivered → read, or failed) exactly as
 * the Lead 360's bubbles show them. No column is added: the message is the
 * evidence, and a second copy of it on the proposal would be a claim.
 *
 * A quotation whose ref names no readable message (sent before the ref was
 * recorded, or a plan-set send) is `unknown`, said as such.
 */
export type QuotationDelivery = 'not_sent' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';

export async function readQuotationDeliveries(
  proposals: readonly { id: string; sent_at: string | null; sent_message_ref: string | null }[],
): Promise<Map<string, QuotationDelivery>> {
  const out = new Map<string, QuotationDelivery>();
  const refs = [...new Set(proposals.map((p) => p.sent_message_ref).filter((r): r is string => r !== null && /^[0-9a-f-]{36}$/i.test(r)))];

  const wireById = new Map<string, unknown>();
  if (refs.length > 0) {
    const supabase = await createClient();
    const { data, error } = await supabase.schema('crm').from('conversation_messages').select('id, metadata').in('id', refs);
    if (error) unreadable('readQuotationDeliveries', error);
    for (const m of data ?? []) wireById.set(m.id, m.metadata);
  }

  for (const p of proposals) {
    if (!p.sent_at) {
      out.set(p.id, 'not_sent');
      continue;
    }
    const metadata = p.sent_message_ref ? wireById.get(p.sent_message_ref) : undefined;
    if (metadata === undefined) {
      out.set(p.id, 'unknown');
      continue;
    }
    const m = (metadata ?? {}) as Record<string, unknown>;
    const wire = m.wire_status;
    const delivery = m.delivery;
    if (wire === 'read' || wire === 'delivered' || wire === 'failed' || wire === 'sent') out.set(p.id, wire);
    else if (delivery === 'failed') out.set(p.id, 'failed');
    else if (delivery === 'sent') out.set(p.id, 'sent');
    else if (delivery === 'pending') out.set(p.id, 'pending');
    else out.set(p.id, 'unknown');
  }
  return out;
}
