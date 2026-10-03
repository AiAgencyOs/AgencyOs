import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type RequirementQuestionSend = {
  questionIndex: number;
  question: string;
  conversationId: string;
  messageId: string;
  sentAt: string;
  sentBy: string | null;
};

/**
 * SCR-029 — which open questions of each version have been put in front of
 * the client on their own (`crm.requirement_question_sends`), keyed by
 * version id then question index. A version nobody asked anything about maps
 * to an empty map; a failed read refuses.
 */
export async function readRequirementQuestionSends(versionIds: readonly string[]): Promise<Map<string, Map<number, RequirementQuestionSend>>> {
  const out = new Map<string, Map<number, RequirementQuestionSend>>();
  if (versionIds.length === 0) return out;
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('requirement_question_sends')
    .select('requirement_version_id, question_index, question, conversation_id, message_id, sent_at, sent_by')
    .in('requirement_version_id', [...versionIds])
    .order('sent_at', { ascending: false });
  if (error) unreadable('readRequirementQuestionSends', error);

  for (const r of data ?? []) {
    const byIndex = out.get(r.requirement_version_id) ?? new Map<number, RequirementQuestionSend>();
    byIndex.set(r.question_index, {
      questionIndex: r.question_index,
      question: r.question,
      conversationId: r.conversation_id,
      messageId: r.message_id,
      sentAt: r.sent_at,
      sentBy: r.sent_by,
    });
    out.set(r.requirement_version_id, byIndex);
  }
  return out;
}
