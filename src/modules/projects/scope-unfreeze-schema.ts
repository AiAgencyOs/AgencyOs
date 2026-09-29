import { z } from 'zod';

/**
 * SCR-030 — the owner's unfreeze override on a scope baseline
 * (`projects.unfreeze_scope_version`, 20260929190000).
 */
export const unfreezeScopeVersionSchema = z.object({
  projectId: z.uuid(),
  scopeVersionId: z.uuid(),
  reason: z.string().trim().min(10, 'Say why, in at least ten characters.').max(2000),
});
export type UnfreezeScopeVersionInput = z.infer<typeof unfreezeScopeVersionSchema>;
