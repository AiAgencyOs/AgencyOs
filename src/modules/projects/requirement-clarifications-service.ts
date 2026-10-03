import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  answerRequirementClarificationSchema,
  raiseRequirementClarificationSchema,
  type AnswerRequirementClarificationInput,
  type RaiseRequirementClarificationInput,
} from './requirement-clarifications-schema';

/**
 * The two requirement clarification doors. `task.write` here; the functions
 * re-check `core.can_write()` and audit. A question is raised against a
 * requirement (scope item), needs no plan, and stays open until answered.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function raiseRequirementClarification(input: RaiseRequirementClarificationInput): Promise<Result<{ clarificationId: string }>> {
  const parsed = raiseRequirementClarificationSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid question.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to ask a clarification.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('raise_requirement_clarification', {
    p_scope_item_id: parsed.data.scopeItemId,
    p_question: parsed.data.question,
    p_impact: parsed.data.impact,
  });
  if (error) {
    log('raiseRequirementClarification', error.message);
    return err('INTERNAL', 'Could not raise the clarification.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; clarification_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'raised':
      return row.clarification_id ? ok({ clarificationId: row.clarification_id }) : err('INTERNAL', 'Could not raise the clarification.');
    case 'empty':
      return err('VALIDATION', 'Write the question and what the answer changes.');
    case 'too_long':
      return err('VALIDATION', 'The question and the impact are at most 1000 characters each.');
    case 'not_found':
      return err('NOT_FOUND', 'That requirement is not visible to you.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin, delivery lead or other writing role may ask.');
  }
}

export async function answerRequirementClarification(input: AnswerRequirementClarificationInput): Promise<Result<{ answered: true }>> {
  const parsed = answerRequirementClarificationSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid answer.');

  const context = await requireInternal();
  if (!can(context, 'task.write')) return err('FORBIDDEN', 'You do not have permission to answer a clarification.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('answer_requirement_clarification', {
    p_clarification_id: parsed.data.clarificationId,
    p_answer: parsed.data.answer,
  });
  if (error) {
    log('answerRequirementClarification', error.message);
    return err('INTERNAL', 'Could not record the answer.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'answered':
      return ok({ answered: true });
    case 'already_answered':
      return err('CONFLICT', 'That question is already answered.');
    case 'empty':
      return err('VALIDATION', 'Write the answer first.');
    case 'too_long':
      return err('VALIDATION', 'An answer is at most 2000 characters.');
    case 'not_found':
      return err('NOT_FOUND', 'That question is not visible to you.');
    default:
      return err('FORBIDDEN', 'The database refused: only a writing role may answer.');
  }
}
