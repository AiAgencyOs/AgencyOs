import { z } from 'zod';

/** A clarification asked of one requirement, and its answer — migration 20261006400000. */
export const raiseRequirementClarificationSchema = z.object({
  scopeItemId: z.uuid(),
  question: z.string().trim().min(1, 'Write the question first.').max(1000, 'A question is at most 1000 characters.'),
  impact: z.string().trim().min(1, 'Say what the answer changes.').max(1000, 'The impact is at most 1000 characters.'),
});
export type RaiseRequirementClarificationInput = z.input<typeof raiseRequirementClarificationSchema>;

export const answerRequirementClarificationSchema = z.object({
  clarificationId: z.uuid(),
  answer: z.string().trim().min(1, 'Write the answer first.').max(2000, 'An answer is at most 2000 characters.'),
});
export type AnswerRequirementClarificationInput = z.input<typeof answerRequirementClarificationSchema>;
