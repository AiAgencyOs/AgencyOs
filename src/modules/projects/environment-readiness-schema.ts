import { z } from 'zod';

/**
 * SCR-043 — an environment's three readiness checks and the build promoted
 * to it (migration 20261001130000). The gate (readiness + release gates) is
 * `projects.promote_build`'s; these shape the input.
 */

export const READINESS_CHECKS = ['api_contract', 'migrations', 'external_config'] as const;
export type ReadinessCheck = (typeof READINESS_CHECKS)[number];

export const READINESS_CHECK_LABEL: Record<ReadinessCheck, string> = {
  api_contract: 'API contracts',
  migrations: 'DB migrations',
  external_config: 'External service configuration',
};

export const recordEnvironmentCheckSchema = z.object({
  projectId: z.uuid(),
  environmentId: z.uuid(),
  check: z.enum(READINESS_CHECKS),
  ok: z.boolean(),
  evidenceUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v.length === 0 || v.startsWith('https://'), 'Evidence is a link that starts with https://')
    .optional(),
  note: z.string().trim().max(1000).optional(),
});
export type RecordEnvironmentCheckInput = z.input<typeof recordEnvironmentCheckSchema>;

export const promoteBuildSchema = z.object({
  projectId: z.uuid(),
  environmentId: z.uuid(),
  deliverableId: z.uuid(),
});
export type PromoteBuildInput = z.infer<typeof promoteBuildSchema>;
