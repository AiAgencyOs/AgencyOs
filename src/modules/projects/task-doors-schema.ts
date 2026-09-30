import { z } from 'zod';

/**
 * SCR-041 — the task page's four doors (migration 20261001130000): start,
 * mark ready for QA, submit evidence, reopen from a defect. The transitions
 * are the database's; these shape the input.
 */

export const EVIDENCE_KINDS = ['test', 'implementation', 'review', 'other'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const taskIdSchema = z.object({ projectId: z.uuid(), taskId: z.uuid() });
export type TaskIdInput = z.infer<typeof taskIdSchema>;

export const submitTaskEvidenceSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  kind: z.enum(EVIDENCE_KINDS),
  title: z.string().trim().min(1, 'Name the evidence.').max(200),
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v.length === 0 || /^https?:\/\//.test(v), 'A link starts with http:// or https://')
    .optional(),
  note: z.string().trim().max(4000).optional(),
});
export type SubmitTaskEvidenceInput = z.input<typeof submitTaskEvidenceSchema>;

export const reopenTaskFromDefectSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  defectId: z.uuid(),
});
export type ReopenTaskFromDefectInput = z.infer<typeof reopenTaskFromDefectSchema>;
