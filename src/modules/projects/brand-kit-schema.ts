import { z } from 'zod';

/** SCR-038 — a written brand rule of the project's brand kit (migration 20261006400100). */
export const addBrandRuleSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1, 'Name the rule.').max(120, 'A rule title is at most 120 characters.'),
  rule: z.string().trim().min(1, 'Write the rule.').max(2000, 'A rule is at most 2000 characters.'),
});
export type AddBrandRuleInput = z.input<typeof addBrandRuleSchema>;

export const removeBrandRuleSchema = z.object({ projectId: z.uuid(), ruleId: z.uuid() });
export type RemoveBrandRuleInput = z.input<typeof removeBrandRuleSchema>;
