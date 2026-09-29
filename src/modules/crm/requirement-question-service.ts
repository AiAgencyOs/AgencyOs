import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { requirementQuestionMessage, sendRequirementQuestionSchema, type SendRequirementQuestionInput } from './requirement-question-schema';

export type QuestionSent = { versionId: string; questionIndex: number; messageId: string };

/**
 * Puts ONE open question of a requirement version in front of the client —
 * SCR-029's "Request client clarification", per question.
 *
 * The door is `crm.send_requirement_question`: it re-reads the version under
 * RLS, checks the question at that index is the question the caller named,
 * and sends through `crm.send_outbound_message` — the chokepoint every
 * outbound message goes through, so consent (ADM-70), the 24-hour window and
 * template rule, the outbound kill switch and the idempotency key keep
 * deciding. It records the send in `crm.requirement_question_sends` and
 * audits `requirement.question_sent`. It does not read the reply.
 *
 * Gated on `lead.write` (owner, ops_admin) — the roles that may decide a
 * version; the door re-checks `core.is_admin()` and RLS decides again.
 */
export async function sendRequirementQuestion(input: SendRequirementQuestionInput): Promise<Result<QuestionSent>> {
  const parsed = sendRequirementQuestionSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Not a question this version holds.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to send a clarification.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('send_requirement_question', {
    p_version_id: parsed.data.versionId,
    p_question_index: parsed.data.questionIndex,
    p_question: parsed.data.question,
    p_body: requirementQuestionMessage(parsed.data.question),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendRequirementQuestion', detail: error.message }));
    return err('INTERNAL', 'The question could not be sent.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; message_id: string | null } | undefined;

  switch (row?.outcome) {
    case 'sent':
      return ok({ versionId: parsed.data.versionId, questionIndex: parsed.data.questionIndex, messageId: row.message_id ?? '' });
    case 'already_sent':
      return err('CONFLICT', 'This question has already been sent to the client.');
    case 'no_actor':
      return err('FORBIDDEN', 'No signed-in person to record the send against.');
    case 'forbidden':
      return err('FORBIDDEN', 'Only the owner or an ops admin can send a clarification.');
    case 'not_found':
      return err('NOT_FOUND', 'Requirement version not found.');
    case 'not_open':
      return err('CONFLICT', 'Only a proposed or accepted version can ask the client a question; this one is history.');
    case 'question_mismatch':
      return err('CONFLICT', 'The version changed under the form — reload and read the question again before sending.');
    case 'no_consent':
      return err('FORBIDDEN', 'This contact has not agreed to be messaged, so nothing was sent.');
    case 'outbound_paused':
      return err('FORBIDDEN', 'Outbound messaging is paused by the owner, so nothing was sent.');
    default:
      return err('INTERNAL', `The question could not be sent (${row?.outcome ?? 'no answer'}).`);
  }
}
