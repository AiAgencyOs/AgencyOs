import { z } from 'zod';

/** SCR-037 — a prototype build names its platform and is submitted to QA (migration 20261001130000). */

export const PROTOTYPE_PLATFORMS = ['web', 'ios', 'android', 'desktop', 'cross_platform'] as const;
export type PrototypePlatform = (typeof PROTOTYPE_PLATFORMS)[number];

export const setPrototypePlatformSchema = z.object({
  projectId: z.uuid(),
  artifactId: z.uuid(),
  platform: z.enum(PROTOTYPE_PLATFORMS),
});
export type SetPrototypePlatformInput = z.infer<typeof setPrototypePlatformSchema>;

export const submitPrototypeToQaSchema = z.object({
  projectId: z.uuid(),
  artifactId: z.uuid(),
});
export type SubmitPrototypeToQaInput = z.infer<typeof submitPrototypeToQaSchema>;
