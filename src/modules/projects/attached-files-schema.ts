import { z } from 'zod';

/**
 * A file that belongs to a build, a test run or a bug — owner decisions Q-C1
 * and Q-C6 of 2026-10-01 (migration 20261009300100). The kinds mirror the
 * `projects.attached_files.subject_kind` check.
 */
export const ATTACHED_SUBJECT_KINDS = ['build', 'test_run', 'defect'] as const;
export type AttachedSubjectKind = (typeof ATTACHED_SUBJECT_KINDS)[number];

export const attachFileSchema = z.object({
  subjectKind: z.enum(ATTACHED_SUBJECT_KINDS),
  subjectId: z.uuid(),
});
export type AttachFileInput = z.input<typeof attachFileSchema>;

/** The words each kind of subject goes by in a sentence, and which area of the bucket holds its files. */
export const ATTACHED_SUBJECT_NOUN: Record<AttachedSubjectKind, { noun: string; area: 'build' | 'evidence' }> = {
  build: { noun: 'build file', area: 'build' },
  test_run: { noun: 'evidence file', area: 'evidence' },
  defect: { noun: 'evidence file', area: 'evidence' },
};
