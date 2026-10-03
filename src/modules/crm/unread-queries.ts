import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-057 "Unread count" — the honest reading this data model supports: an
 * active conversation whose NEWEST message is the client's, with nothing
 * from a person or the agent after it. There is no per-person read receipt
 * on a thread (a message is read by whoever opens the lead), so "unread"
 * here means "unanswered", and the tile says so in its caption.
 */
export type UnansweredThread = { conversationId: string; leadId: string | null; lastInboundAt: string };

export async function listUnansweredConversations(limit = 500): Promise<UnansweredThread[]> {
  const supabase = await createClient();
  const { data: conversations, error } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, lead_id')
    .eq('status', 'active')
    .limit(limit);
  if (error) unreadable('listUnansweredConversations.conversations', error);
  const ids = (conversations ?? []).map((c) => c.id);
  if (ids.length === 0) return [];

  const { data: messages, error: mError } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('conversation_id, author_type, occurred_at')
    .in('conversation_id', ids)
    .order('occurred_at', { ascending: false })
    .limit(5000);
  if (mError) unreadable('listUnansweredConversations.messages', mError);

  const newest = new Map<string, { author_type: string; occurred_at: string }>();
  for (const m of messages ?? []) if (!newest.has(m.conversation_id)) newest.set(m.conversation_id, m);

  const leadById = new Map((conversations ?? []).map((c) => [c.id, c.lead_id]));
  return [...newest.entries()]
    .filter(([, m]) => m.author_type === 'client')
    .map(([conversationId, m]) => ({ conversationId, leadId: leadById.get(conversationId) ?? null, lastInboundAt: m.occurred_at }))
    .sort((a, b) => a.lastInboundAt.localeCompare(b.lastInboundAt));
}
