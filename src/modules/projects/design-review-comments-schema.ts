import { z } from 'zod';

/** A comment on a design under review — migration 20261006400100. Appended, never edited. */
export const commentOnDesignReviewSchema = z.object({
  projectId: z.uuid(),
  subjectType: z.enum(['theme_option', 'deliverable']),
  subjectId: z.uuid(),
  body: z.string().trim().min(1, 'Write a comment first.').max(2000, 'A comment is at most 2000 characters.'),
});
export type CommentOnDesignReviewInput = z.input<typeof commentOnDesignReviewSchema>;
