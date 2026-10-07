import { z } from 'zod';

/** P5-FEED-02's vocabulary and answer shape: pure, so the workflow and its tests share one definition. */

export const BUILD_FEEDBACK_CLASSES = ['bug', 'missed_requirement', 'ui_mismatch', 'included_small_revision', 'clarification', 'possible_scope_change', 'new_feature'] as const;

export const buildFeedbackSuggestionSchema = z
  .object({
    classification: z.enum(BUILD_FEEDBACK_CLASSES),
    reasoning: z.string().trim().min(1).max(600),
    clarifyingQuestion: z.string().trim().max(2000).nullish(),
  })
  .strict()
  .refine((v) => v.classification !== 'clarification' || Boolean(v.clarifyingQuestion && v.clarifyingQuestion.length > 0), {
    message: 'a clarification names the exact question to ask',
    path: ['clarifyingQuestion'],
  });

export function buildFeedbackSuggestionJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      classification: { type: 'string', enum: [...BUILD_FEEDBACK_CLASSES] },
      reasoning: { type: 'string', description: 'One sentence on why, at most 600 characters.' },
      clarifyingQuestion: { type: ['string', 'null'], description: 'Only for a clarification: the exact question to ask the client, at most 2000 characters.' },
    },
    required: ['classification', 'reasoning'],
    additionalProperties: false,
  };
}

