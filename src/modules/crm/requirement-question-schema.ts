import { z } from 'zod';

/**
 * SCR-029 (bucket G-3) — "Request client clarification", one question at a
 * time. The door (`crm.send_requirement_question`) takes the version, the
 * index of the question in its `openQuestions` payload, and the question's
 * text; it refuses when the two disagree, so a version that changed under
 * the form cannot send a different question than the one the person read.
 */
export const sendRequirementQuestionSchema = z.object({
  versionId: z.uuid(),
  questionIndex: z.coerce.number().int().min(0).max(49),
  question: z.string().trim().min(1).max(500),
});

export type SendRequirementQuestionInput = z.infer<typeof sendRequirementQuestionSchema>;

/**
 * The message as the client reads it — composed in code from the stored
 * question, never by a model, for the same reason the whole-version summary
 * is (`requirementConfirmationMessage`): a restated question is how a client
 * answers something nobody asked. Plain, short, and it says what it is.
 */
export function requirementQuestionMessage(question: string): string {
  return ['One question on the scope we discussed, so we can plan it right:', '', question.trim(), '', 'Could you reply here with your answer?'].join('\n');
}
