import { z } from 'zod';

import { RUN_ENVIRONMENTS, TEST_RUN_SUITES } from './schema';

/**
 * A test run has a life — SCR-046, bucket F. Opened against a build, worked,
 * closed once with its final counts (passed, failed, skipped, blocked). A
 * closed run's failed or blocked cases can be rerun: a NEW run of the same
 * suite against the same build, pointing back at the one it re-executes.
 * The database (20261001140000) decides every transition again.
 */
export const openTestRunSchema = z.object({
  projectId: z.uuid(),
  deliverableId: z.uuid(),
  suite: z.enum(TEST_RUN_SUITES),
  device: z.string().trim().max(120).optional(),
  browser: z.string().trim().max(120).optional(),
  os: z.string().trim().max(120).optional(),
  /** SCR-046: the environment the build runs in, and who runs the suite (default: the person opening it). */
  environment: z.enum(RUN_ENVIRONMENTS).optional(),
  testerId: z.uuid().optional(),
});
export type OpenTestRunInput = z.infer<typeof openTestRunSchema>;

export const closeTestRunSchema = z.object({
  projectId: z.uuid(),
  runId: z.uuid(),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0).default(0),
  blocked: z.number().int().min(0).default(0),
  evidenceUrl: z.url().optional(),
  perfNotes: z.string().trim().max(4000).optional(),
});
export type CloseTestRunInput = z.infer<typeof closeTestRunSchema>;

export const rerunTestRunSchema = z.object({
  projectId: z.uuid(),
  runId: z.uuid(),
});
export type RerunTestRunInput = z.infer<typeof rerunTestRunSchema>;

/** SCR-046 — one more piece of evidence on a run, open or closed (`qa.add_run_evidence`). */
export const RUN_EVIDENCE_KINDS = ['screenshot', 'log', 'report', 'recording', 'note'] as const;
export type RunEvidenceKind = (typeof RUN_EVIDENCE_KINDS)[number];

export const addRunEvidenceSchema = z
  .object({
    projectId: z.uuid(),
    runId: z.uuid(),
    kind: z.enum(RUN_EVIDENCE_KINDS),
    value: z.string().trim().min(1, 'Add a link, or the words for a note.').max(2000),
    label: z.string().trim().max(160).optional(),
  })
  .refine((v) => v.kind === 'note' || /^https?:\/\/\S+$/i.test(v.value), {
    message: 'A screenshot, log, report or recording is a link that starts with http:// or https://.',
    path: ['value'],
  });
export type AddRunEvidenceInput = z.infer<typeof addRunEvidenceSchema>;
