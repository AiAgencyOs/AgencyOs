import { z } from 'zod';

import { TEST_RUN_SUITES } from './schema';

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
