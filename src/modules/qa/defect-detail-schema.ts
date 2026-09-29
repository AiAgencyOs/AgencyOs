import { z } from 'zod';

/**
 * SCR-047 — evidence and the build link (migration 20261001160000).
 * Both mirror the door's own checks so a bad form is a field error.
 */

export const DEFECT_EVIDENCE_KINDS = ['url', 'note'] as const;
export type DefectEvidenceKind = (typeof DEFECT_EVIDENCE_KINDS)[number];

export const addDefectEvidenceSchema = z
  .object({
    defectId: z.uuid(),
    kind: z.enum(DEFECT_EVIDENCE_KINDS),
    value: z.string().trim().min(1, 'Say what the evidence is, or paste its link.').max(2000),
  })
  .refine((v) => v.kind !== 'url' || /^https?:\/\/\S+$/i.test(v.value), {
    message: 'A link starts with http:// or https://.',
    path: ['value'],
  });

export type AddDefectEvidenceInput = z.infer<typeof addDefectEvidenceSchema>;

/** `qa.link_defect_build`: null unlinks. */
export const linkDefectBuildSchema = z.object({
  defectId: z.uuid(),
  buildId: z.uuid().nullable(),
});

export type LinkDefectBuildInput = z.infer<typeof linkDefectBuildSchema>;
