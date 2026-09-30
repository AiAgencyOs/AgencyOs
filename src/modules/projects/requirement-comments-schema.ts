import { z } from 'zod';

/** A comment on a requirement (a scope item) — migration 20261004300000. Appended, never edited. */
export const commentOnRequirementSchema = z.object({
  scopeItemId: z.uuid(),
  body: z.string().trim().min(1, 'Write a comment first.').max(2000, 'A comment is at most 2000 characters.'),
});

export type CommentOnRequirementInput = z.input<typeof commentOnRequirementSchema>;
