import { z } from 'zod';

/** SCR-030 "Approval evidence" (migration 20261001120000). Who approved a frozen baseline, and where the evidence lives. */
export const recordScopeApprovalSchema = z.object({
  scopeVersionId: z.uuid(),
  approvedBy: z.string().trim().min(1, 'Name who approved it — as they signed.').max(200),
  evidenceUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), 'The evidence link must start with http:// or https://.')
    .optional(),
  note: z.string().trim().max(1000).optional(),
});

export type RecordScopeApprovalInput = z.input<typeof recordScopeApprovalSchema>;
